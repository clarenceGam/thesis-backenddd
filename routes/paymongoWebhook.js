const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const paymongoService = require("../services/paymongoService");

// ═══════════════════════════════════════════════════════════════════════════
// PAYMONGO WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /paymongo-webhook — Handle PayMongo webhook events
 * This endpoint receives notifications from PayMongo when payment status changes
 */
router.post("/", express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['paymongo-signature'];
    const payload = req.body;

    // Parse the webhook payload
    let event;
    try {
      event = JSON.parse(payload.toString());
    } catch (err) {
      console.error('Invalid webhook payload:', err);
      return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    const eventId = event.data?.id;
    const eventType = event.data?.attributes?.type;
    
    if (!eventId || !eventType) {
      console.error('Missing event ID or type');
      return res.status(400).json({ success: false, message: 'Missing event data' });
    }

    // Check if event already processed
    const [existingEvents] = await pool.query(
      "SELECT id, processed FROM webhook_events WHERE event_id = ? LIMIT 1",
      [eventId]
    );

    if (existingEvents.length && existingEvents[0].processed) {
      console.log(`Webhook event ${eventId} already processed. Skipping.`);
      return res.json({ success: true, message: 'Event already processed' });
    }

    // Save webhook event
    const resourceType = event.data?.attributes?.data?.attributes?.type || 'unknown';
    const resourceId = event.data?.attributes?.data?.id || 'unknown';

    await pool.query(
      `INSERT INTO webhook_events (event_id, event_type, resource_type, resource_id, payload, processed)
       VALUES (?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
      [eventId, eventType, resourceType, resourceId, JSON.stringify(event)]
    );

    // Process based on event type
    let processingResult = { success: true, message: 'Webhook received' };

    switch (eventType) {
      case 'source.chargeable':
        processingResult = await handleSourceChargeable(event);
        break;
      
      case 'payment.paid':
        processingResult = await handlePaymentPaid(event);
        break;
      
      case 'payment.failed':
        processingResult = await handlePaymentFailed(event);
        break;
      
      default:
        console.log(`Unhandled event type: ${eventType}`);
        processingResult = { success: true, message: `Event type ${eventType} not handled` };
    }

    // Mark event as processed
    await pool.query(
      "UPDATE webhook_events SET processed = 1, processed_at = NOW(), error_message = ? WHERE event_id = ?",
      [processingResult.success ? null : processingResult.message, eventId]
    );

    return res.json({ success: true, message: 'Webhook processed', result: processingResult });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * Handle source.chargeable event (GCash/PayMaya payment approved)
 */
async function handleSourceChargeable(event) {
  try {
    const sourceId = event.data?.attributes?.data?.id;
    if (!sourceId) return { success: false, message: 'Missing source ID' };

    // Find payment transaction by source ID
    const [payments] = await pool.query(
      "SELECT * FROM payment_transactions WHERE paymongo_source_id = ? LIMIT 1",
      [sourceId]
    );

    if (!payments.length) {
      console.log(`No payment found for source ${sourceId}`);
      return { success: false, message: 'Payment not found' };
    }

    const payment = payments[0];

    // Create actual payment from source
    const paymongoPayment = await paymongoService.attachSourceToPayment(sourceId, {
      amount: Math.round(Number(payment.amount || 0) * 100),
      description: `Payment for ${payment.payment_type} #${payment.related_id}`,
    });

    // Update payment transaction
    await pool.query(
      `UPDATE payment_transactions 
       SET paymongo_payment_id = ?, status = 'processing' 
       WHERE id = ?`,
      [paymongoPayment.id, payment.id]
    );

    return { success: true, message: 'Source attached to payment' };
  } catch (err) {
    console.error('Handle Source Chargeable Error:', err);
    return { success: false, message: err.message };
  }
}

/**
 * Handle payment.paid event (Payment successfully completed)
 */
async function handlePaymentPaid(event) {
  try {
    const paymentData = event.data?.attributes?.data;
    const paymongoPaymentId = paymentData?.id;
    const paymongoSourceId = paymentData?.attributes?.source?.id;

    if (!paymongoPaymentId && !paymongoSourceId) {
      return { success: false, message: 'Missing payment/source ID' };
    }

    // Find payment transaction
    const [payments] = await pool.query(
      `SELECT * FROM payment_transactions 
       WHERE paymongo_payment_id = ? OR paymongo_source_id = ?
       LIMIT 1`,
      [paymongoPaymentId, paymongoSourceId]
    );

    if (!payments.length) {
      console.log(`No payment found for PayMongo payment ${paymongoPaymentId}`);
      return { success: false, message: 'Payment not found' };
    }

    const payment = payments[0];

    // Update payment status to paid
    await pool.query(
      `UPDATE payment_transactions 
       SET status = 'paid', paid_at = NOW(), paymongo_payment_id = ?
       WHERE id = ? AND status <> 'paid'`,
      [paymongoPaymentId || payment.paymongo_payment_id, payment.id]
    );

    // Process based on payment type
    if (payment.payment_type === 'order') {
      await handleOrderPaymentPaid(payment);
    } else if (payment.payment_type === 'reservation') {
      await handleReservationPaymentPaid(payment);
    } else if (payment.payment_type === 'subscription') {
      await handleSubscriptionPaymentPaid(payment);
    }

    return { success: true, message: `Payment ${payment.reference_id} marked as paid` };
  } catch (err) {
    console.error('Handle Payment Paid Error:', err);
    return { success: false, message: err.message };
  }
}

/**
 * Handle payment.failed event — treated as 'cancelled' (user clicked Fail/Expire in test mode)
 */
async function handlePaymentFailed(event) {
  try {
    const paymentData = event.data?.attributes?.data;
    const paymongoPaymentId = paymentData?.id;
    const failedReason = paymentData?.attributes?.last_payment_error?.failed_message || 'Payment cancelled';

    const [payments] = await pool.query(
      "SELECT * FROM payment_transactions WHERE paymongo_payment_id = ? LIMIT 1",
      [paymongoPaymentId]
    );

    if (!payments.length) {
      return { success: false, message: 'Payment not found' };
    }

    const payment = payments[0];

    // Update payment status to cancelled
    await pool.query(
      "UPDATE payment_transactions SET status = 'cancelled', failed_reason = ? WHERE id = ?",
      [failedReason, payment.id]
    );

    // Update related records
    if (payment.payment_type === 'order') {
      await pool.query("UPDATE pos_orders SET payment_status = 'cancelled' WHERE id = ?", [payment.related_id]);
    } else if (payment.payment_type === 'reservation') {
      await pool.query(
        "UPDATE reservations SET payment_status = 'cancelled', status = 'cancelled' WHERE id = ? AND status NOT IN ('confirmed','cancelled')",
        [payment.related_id]
      );
    } else if (payment.payment_type === 'subscription') {
      await pool.query("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?", [payment.related_id]);
      await pool.query("UPDATE subscription_payments SET status = 'cancelled' WHERE subscription_id = ?", [payment.related_id]);
    }

    return { success: true, message: 'Payment marked as cancelled' };
  } catch (err) {
    console.error('Handle Payment Failed Error:', err);
    return { success: false, message: err.message };
  }
}

/**
 * Process paid order
 */
async function handleOrderPaymentPaid(payment) {
  await pool.query(
    "UPDATE pos_orders SET payment_status = 'paid', status = 'paid', completed_at = NOW() WHERE id = ?",
    [payment.related_id]
  );

  // Create payout record
  await createPayout(payment);
}

/**
 * Process paid reservation
 */
async function handleReservationPaymentPaid(payment) {
  // Compute total from tables + reservation_items; fallback to payment_line_items; otherwise use deposit
  const [[tableSumRow]] = await pool.query(
    `SELECT COALESCE(SUM(bt.price), 0) AS table_total
     FROM reservation_tables rt
     JOIN bar_tables bt ON bt.id = rt.table_id
     WHERE rt.reservation_id = ?`,
    [payment.related_id]
  );
  const tableTotal = Number(tableSumRow?.table_total || 0);

  const [[itemSumRow]] = await pool.query(
    `SELECT COALESCE(SUM(ri.quantity * ri.unit_price), 0) AS items_total
     FROM reservation_items ri
     WHERE ri.reservation_id = ?`,
    [payment.related_id]
  );
  const itemsTotal = Number(itemSumRow?.items_total || 0);

  let computedTotal = tableTotal + itemsTotal;

  // Always consider payment_line_items total (captures full order breakdown from checkout)
  let pliTotal = 0;
  if (payment.id) {
    const [[pliSumRow]] = await pool.query(
      `SELECT COALESCE(SUM(line_total), 0) AS pli_total
       FROM payment_line_items
       WHERE payment_transaction_id = ?`,
      [payment.id]
    );
    pliTotal = Number(pliSumRow?.pli_total || 0);
  }
  computedTotal = Math.max(computedTotal, pliTotal);

  const [[resRow]] = await pool.query(
    `SELECT deposit_amount FROM reservations WHERE id = ? LIMIT 1`,
    [payment.related_id]
  );

  const paidAmount = Number(payment.amount || 0);
  const depositAmount = Number(resRow?.deposit_amount || 0);
  const targetTotal = computedTotal > 0 ? computedTotal : depositAmount;
  const newPaymentStatus = targetTotal > 0 && paidAmount < targetTotal ? 'partial' : 'paid';

  await pool.query(
    "UPDATE reservations SET payment_status = ?, status = 'confirmed', paid_at = NOW() WHERE id = ?",
    [newPaymentStatus, payment.related_id]
  );

  // Create payout record
  await createPayout(payment);
}

/**
 * Process paid subscription - activate it
 */
async function handleSubscriptionPaymentPaid(payment) {
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

  console.log(`Subscription ${sub.id} activated for owner ${sub.bar_owner_id}`);
}

/**
 * Create payout record for bar owner
 */
async function createPayout(payment) {
  if (!payment.bar_id) return;

  const [existingPayout] = await pool.query(
    "SELECT id FROM payouts WHERE payment_transaction_id = ? LIMIT 1",
    [payment.id]
  );
  if (existingPayout.length) return;

  // Get platform fee percentage
  const [settings] = await pool.query(
    "SELECT setting_value FROM platform_settings WHERE setting_key = 'platform_fee_percentage' LIMIT 1"
  );
  const feePercentage = settings.length ? parseFloat(settings[0].setting_value) : 5.0;

  const grossAmount = parseFloat(payment.amount);
  const platformFeeAmount = (grossAmount * feePercentage) / 100;
  const netAmount = grossAmount - platformFeeAmount;

  // Get bar GCash details
  const [bars] = await pool.query(
    "SELECT gcash_number, gcash_account_name FROM bars WHERE id = ? LIMIT 1",
    [payment.bar_id]
  );

  const gcashNumber = bars.length ? bars[0].gcash_number : null;
  const gcashAccountName = bars.length ? bars[0].gcash_account_name : null;

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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'gcash', ?, ?)`,
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
      gcashNumber,
      gcashAccountName,
    ]
  );
}

module.exports = router;
