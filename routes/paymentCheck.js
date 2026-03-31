const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const paymongoService = require("../services/paymongoService");

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL PAYMENT CHECK (FOR DEVELOPMENT/TESTING)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /payment-check/verify/:reference_id
 * Manually check payment status from PayMongo and update database
 * USE THIS FOR LOCAL DEVELOPMENT when webhooks can't reach localhost
 */
router.post("/verify/:reference_id", async (req, res) => {
  try {
    const referenceId = req.params.reference_id;

    // Get payment transaction
    const [payments] = await pool.query(
      "SELECT * FROM payment_transactions WHERE reference_id = ? LIMIT 1",
      [referenceId]
    );

    if (!payments.length) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const payment = payments[0];

    if (payment.status === 'paid') {
      return res.json({ success: true, message: "Payment already confirmed", data: payment });
    }

    // Check PayMongo for payment status
    await paymongoService.loadKeys();
    let paymongoPayment = null;

    try {
      // Try to get payment by source ID (GCash/PayMaya)
      if (payment.paymongo_source_id) {
        const axios = require('axios');
        const response = await axios.get(
          `https://api.paymongo.com/v1/sources/${payment.paymongo_source_id}`,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(paymongoService.secretKey).toString('base64')}`,
            },
          }
        );
        paymongoPayment = response.data.data;

        // Check if source is already paid/consumed or can be attached now
        if (['chargeable', 'paid', 'consumed'].includes(paymongoPayment.attributes.status)) {
          console.log(`Source ${payment.paymongo_source_id} is ${paymongoPayment.attributes.status}. Updating payment...`);
          
          // Update payment status
          await pool.query(
            "UPDATE payment_transactions SET status = 'paid', paid_at = NOW() WHERE id = ?",
            [payment.id]
          );

          // Process based on payment type
          if (payment.payment_type === 'subscription') {
            await activateSubscription(payment);
          } else if (payment.payment_type === 'order') {
            await updateOrder(payment);
          } else if (payment.payment_type === 'reservation') {
            await updateReservation(payment);
          }

          return res.json({
            success: true,
            message: "Payment confirmed and processed!",
            data: {
              reference_id: referenceId,
              status: 'paid',
              payment_type: payment.payment_type,
            },
          });
        } else if (paymongoPayment.attributes.status === 'failed' || paymongoPayment.attributes.status === 'expired' || paymongoPayment.attributes.status === 'inactive') {
          await pool.query(
            "UPDATE payment_transactions SET status = 'cancelled', failed_reason = 'Payment cancelled' WHERE id = ?",
            [payment.id]
          );
          if (payment.payment_type === 'order') {
            await pool.query("UPDATE pos_orders SET payment_status = 'cancelled' WHERE id = ?", [payment.related_id]);
          } else if (payment.payment_type === 'reservation') {
            await pool.query("UPDATE reservations SET payment_status = 'cancelled', status = 'cancelled' WHERE id = ?", [payment.related_id]);
          }
          return res.json({
            success: false,
            message: 'Payment cancelled',
            data: { status: 'cancelled' },
          });
        } else {
          return res.json({
            success: false,
            message: `Payment status: ${paymongoPayment.attributes.status}. Please complete payment.`,
            data: { status: paymongoPayment.attributes.status },
          });
        }
      }

      // Try payment intent (cards)
      if (payment.paymongo_payment_intent_id) {
        const axios = require('axios');
        const response = await axios.get(
          `https://api.paymongo.com/v1/payment_intents/${payment.paymongo_payment_intent_id}`,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(paymongoService.secretKey).toString('base64')}`,
            },
          }
        );
        paymongoPayment = response.data.data;

        if (paymongoPayment.attributes.status === 'succeeded') {
          console.log(`Payment intent ${payment.paymongo_payment_intent_id} succeeded. Updating...`);
          
          await pool.query(
            "UPDATE payment_transactions SET status = 'paid', paid_at = NOW() WHERE id = ?",
            [payment.id]
          );

          if (payment.payment_type === 'subscription') {
            await activateSubscription(payment);
          } else if (payment.payment_type === 'order') {
            await updateOrder(payment);
          } else if (payment.payment_type === 'reservation') {
            await updateReservation(payment);
          }

          return res.json({
            success: true,
            message: "Payment confirmed and processed!",
            data: {
              reference_id: referenceId,
              status: 'paid',
              payment_type: payment.payment_type,
            },
          });
        } else {
          if (paymongoPayment.attributes.status === 'awaiting_payment_method' || paymongoPayment.attributes.status === 'awaiting_next_action') {
            await pool.query("UPDATE payment_transactions SET status = 'pending' WHERE id = ?", [payment.id]);
          }
          return res.json({
            success: false,
            message: `Payment status: ${paymongoPayment.attributes.status}`,
            data: { status: paymongoPayment.attributes.status },
          });
        }
      }

      return res.status(400).json({
        success: false,
        message: "No PayMongo payment ID found for this transaction",
      });
    } catch (err) {
      console.error("PayMongo Check Error:", err.response?.data || err.message);
      return res.status(500).json({
        success: false,
        message: err.response?.data?.errors?.[0]?.detail || "Failed to check payment status",
      });
    }
  } catch (err) {
    console.error("PAYMENT CHECK ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * Activate subscription after payment confirmed
 */
async function activateSubscription(payment) {
  const [subs] = await pool.query(
    `SELECT s.*, sp.name AS plan_name, sp.max_bars, sp.billing_period
     FROM subscriptions s
     JOIN subscription_plans sp ON s.plan_id = sp.id
     WHERE s.id = ? LIMIT 1`,
    [payment.related_id]
  );

  if (!subs.length) {
    console.error(`Subscription ${payment.related_id} not found`);
    return;
  }

  const sub = subs[0];

  // Calculate expiry
  let expiresAt = null;
  if (sub.billing_period === 'monthly') {
    expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  } else if (sub.billing_period === 'yearly') {
    expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  }

  // Cancel any existing active subscription
  await pool.query(
    "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE bar_owner_id = ? AND status = 'active' AND id != ?",
    [sub.bar_owner_id, sub.id]
  );

  // Activate this subscription
  await pool.query(
    "UPDATE subscriptions SET status = 'active', starts_at = NOW(), expires_at = ? WHERE id = ?",
    [expiresAt, sub.id]
  );

  // Update subscription payment
  await pool.query(
    "UPDATE subscription_payments SET status = 'paid', paid_at = NOW() WHERE subscription_id = ?",
    [sub.id]
  );

  // Update bar_owners tier
  await pool.query(
    "UPDATE bar_owners SET subscription_tier = ?, subscription_expires_at = ? WHERE id = ?",
    [sub.plan_name, expiresAt, sub.bar_owner_id]
  );

  // Unlock bars up to plan limit
  const [allBars] = await pool.query(
    "SELECT id FROM bars WHERE owner_id = ? ORDER BY created_at ASC",
    [sub.bar_owner_id]
  );
  for (let i = 0; i < allBars.length; i++) {
    const locked = i >= sub.max_bars ? 1 : 0;
    await pool.query("UPDATE bars SET is_locked = ? WHERE id = ?", [locked, allBars[i].id]);
  }

  console.log(`✅ Subscription ${sub.id} ACTIVATED for owner ${sub.bar_owner_id}`);
}

/**
 * Update order status
 */
async function updateOrder(payment) {
  await pool.query("UPDATE pos_orders SET payment_status = 'paid', status = 'paid', completed_at = NOW() WHERE id = ?", [payment.related_id]);
  await createPayout(payment);
  console.log(`✅ Order ${payment.related_id} marked as PAID`);
}

/**
 * Update reservation status
 */
async function updateReservation(payment) {
  const paidAmount = Number(payment.amount || 0);
  let newPaymentStatus = 'paid';
  try {
    const [[resRow]] = await pool.query(
      `SELECT COALESCE(t.price, 0) + COALESCE((
         SELECT SUM(ri.quantity * ri.unit_price) FROM reservation_items ri WHERE ri.reservation_id = r.id
       ), 0) AS total_amount
       FROM reservations r
       LEFT JOIN bar_tables t ON t.id = r.table_id
       WHERE r.id = ? LIMIT 1`,
      [payment.related_id]
    );
    const totalAmount = Number(resRow?.total_amount || 0);
    newPaymentStatus = totalAmount > 0 && paidAmount < totalAmount ? 'partial' : 'paid';
  } catch (err) {
    console.error('PAYMENT_CHECK_UPDATE_RESERVATION_ERR:', err.message);
  }
  await pool.query("UPDATE reservations SET payment_status = ?, status = 'confirmed', paid_at = NOW() WHERE id = ?", [newPaymentStatus, payment.related_id]);
  await createPayout(payment);
  console.log(`✅ Reservation ${payment.related_id} marked as CONFIRMED (payment ${newPaymentStatus})`);
}

async function createPayout(payment) {
  if (!payment.bar_id) return;

  const [existingPayout] = await pool.query(
    "SELECT id FROM payouts WHERE payment_transaction_id = ? LIMIT 1",
    [payment.id]
  );
  if (existingPayout.length) return;

  const [settings] = await pool.query(
    "SELECT setting_value FROM platform_settings WHERE setting_key = 'platform_fee_percentage' LIMIT 1"
  );
  const feePercentage = settings.length ? parseFloat(settings[0].setting_value) : 5.0;

  const grossAmount = parseFloat(payment.amount);
  const platformFeeAmount = (grossAmount * feePercentage) / 100;
  const netAmount = grossAmount - platformFeeAmount;

  const [bars] = await pool.query(
    "SELECT gcash_number, gcash_account_name FROM bars WHERE id = ? LIMIT 1",
    [payment.bar_id]
  );

  const [ownerRows] = await pool.query(
    `SELECT bo.id AS owner_id
     FROM bars b
     LEFT JOIN bar_owners bo ON bo.id = b.owner_id
     WHERE b.id = ?
     LIMIT 1`,
    [payment.bar_id]
  );

  await pool.query(
    `INSERT INTO payouts
     (bar_id, bar_owner_id, payment_transaction_id, order_id, reservation_id, gross_amount,
      platform_fee, platform_fee_amount, net_amount, status, payout_method,
      gcash_number, gcash_account_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'gcash', ?, ?)`,
    [
      payment.bar_id,
      ownerRows[0]?.owner_id || null,
      payment.id,
      payment.payment_type === 'order' ? payment.related_id : null,
      payment.payment_type === 'reservation' ? payment.related_id : null,
      grossAmount,
      feePercentage,
      platformFeeAmount,
      netAmount,
      bars[0]?.gcash_number || null,
      bars[0]?.gcash_account_name || null,
    ]
  );
}

module.exports = router;
