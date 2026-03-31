const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const requireAuth = require("../middlewares/requireAuth");
const paymongoService = require("../services/paymongoService");
const { logAudit, auditContext } = require("../utils/audit");

let _hasPaymentLineItemsTable = null;
let _hasReservationPaymentTransactionId = null;

async function hasPaymentLineItemsTable(conn) {
  if (_hasPaymentLineItemsTable !== null) return _hasPaymentLineItemsTable;
  const [rows] = await conn.query(
    `SELECT 1
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payment_line_items'
     LIMIT 1`
  );
  _hasPaymentLineItemsTable = rows.length > 0;
  return _hasPaymentLineItemsTable;
}

async function hasReservationPaymentTransactionIdColumn(conn) {
  if (_hasReservationPaymentTransactionId !== null) return _hasReservationPaymentTransactionId;
  const [rows] = await conn.query(
    `SELECT 1
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'reservations'
       AND COLUMN_NAME = 'payment_transaction_id'
     LIMIT 1`
  );
  _hasReservationPaymentTransactionId = rows.length > 0;
  return _hasReservationPaymentTransactionId;
}

function parseReservationOrderItems(notes) {
  if (!notes) return [];
  const m = String(notes).match(/Order:\s*(.+)/i);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const qtyMatch = entry.match(/(.+?)\s*x\s*(\d+)$/i);
      if (!qtyMatch) return { name: entry, quantity: 1 };
      return {
        name: qtyMatch[1].trim(),
        quantity: Number(qtyMatch[2]) || 1,
      };
    });
}

async function upsertPaymentLineItems(conn, paymentId, lineItems) {
  if (!(await hasPaymentLineItemsTable(conn))) return;
  await conn.query("DELETE FROM payment_line_items WHERE payment_transaction_id = ?", [paymentId]);
  for (const item of lineItems) {
    await conn.query(
      `INSERT INTO payment_line_items
       (payment_transaction_id, item_type, item_name, quantity, unit_price, line_total, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentId,
        item.item_type,
        item.item_name,
        Number(item.quantity || 1),
        Number(item.unit_price || 0),
        Number(item.line_total || 0),
        item.metadata ? JSON.stringify(item.metadata) : null,
      ]
    );
  }
}

async function buildOrderLineItems(conn, orderId) {
  const [rows] = await conn.query(
    `SELECT item_name, quantity, unit_price, subtotal
     FROM pos_order_items
     WHERE order_id = ?
     ORDER BY id ASC`,
    [orderId]
  );

  return rows.map((r) => ({
    item_type: "menu",
    item_name: r.item_name,
    quantity: Number(r.quantity || 1),
    unit_price: Number(r.unit_price || 0),
    line_total: Number(r.subtotal || 0),
    metadata: null,
  }));
}

async function buildReservationLineItems(conn, reservation) {
  const lineItems = [];

  const tablePrice = Number(reservation.table_price || 0);
  if (tablePrice > 0) {
    lineItems.push({
      item_type: "table",
      item_name: reservation.table_number ? `Table #${reservation.table_number}` : "Table Reservation",
      quantity: 1,
      unit_price: tablePrice,
      line_total: tablePrice,
      metadata: {
        table_id: reservation.table_id,
        reservation_id: reservation.id,
      },
    });
  }

  // First try to fetch from reservation_items table
  const [riCheck] = await conn.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reservation_items' LIMIT 1`
  );

  if (riCheck.length) {
    const [reservationItems] = await conn.query(
      `SELECT ri.menu_item_id, COALESCE(m.menu_name, CONCAT('Item #', ri.menu_item_id)) AS menu_name,
              ri.quantity, ri.unit_price,
              (ri.quantity * ri.unit_price) AS line_total
       FROM reservation_items ri
       LEFT JOIN menu_items m ON m.id = ri.menu_item_id
       WHERE ri.reservation_id = ?
       ORDER BY COALESCE(m.menu_name, 'zzz')`,
      [reservation.id]
    );

    for (const item of reservationItems) {
      lineItems.push({
        item_type: "menu",
        item_name: item.menu_name,
        quantity: Number(item.quantity || 1),
        unit_price: Number(item.unit_price || 0),
        line_total: Number(item.line_total || 0),
        metadata: {
          reservation_id: reservation.id,
          menu_item_id: item.menu_item_id,
        },
      });
    }

    // Supplement with any items from notes not already in results
    if (reservation.notes) {
      const dbNames = new Set(lineItems.filter(i => i.item_type === 'menu').map(i => (i.item_name || '').toLowerCase().trim()));
      const parsedItems = parseReservationOrderItems(reservation.notes);
      for (const it of parsedItems) {
        if (dbNames.has(it.name.toLowerCase().trim())) continue;
        const [menuRows] = await conn.query(
          `SELECT selling_price FROM menu_items WHERE bar_id = ? AND LOWER(menu_name) = LOWER(?) ORDER BY id DESC LIMIT 1`,
          [reservation.bar_id, it.name]
        );
        const unitPrice = Number(menuRows[0]?.selling_price || 0);
        if (unitPrice > 0) {
          lineItems.push({
            item_type: "menu",
            item_name: it.name,
            quantity: Number(it.quantity || 1),
            unit_price: unitPrice,
            line_total: unitPrice * Number(it.quantity || 1),
            metadata: { reservation_id: reservation.id },
          });
        }
      }
    }
  } else {
    // Fallback: parse from notes if reservation_items table doesn't exist
    const parsedItems = parseReservationOrderItems(reservation.notes);
    for (const it of parsedItems) {
      const [menuRows] = await conn.query(
        `SELECT selling_price
         FROM menu_items
         WHERE bar_id = ? AND LOWER(menu_name) = LOWER(?)
         ORDER BY id DESC
         LIMIT 1`,
        [reservation.bar_id, it.name]
      );
      const unitPrice = Number(menuRows[0]?.selling_price || 0);
      lineItems.push({
        item_type: "menu",
        item_name: it.name,
        quantity: Number(it.quantity || 1),
        unit_price: unitPrice,
        line_total: unitPrice * Number(it.quantity || 1),
        metadata: {
          reservation_id: reservation.id,
        },
      });
    }
  }

  return lineItems;
}

function normalizePaymentRow(payment, lineItemsByPaymentId) {
  const items = lineItemsByPaymentId.get(payment.id) || [];
  const tableItem = items.find((i) => i.item_type === "table") || null;
  const menuItems = items.filter((i) => i.item_type === "menu");

  const totalFromLineItems = items.reduce((sum, i) => sum + Number(i.line_total || 0), 0);
  const paidAmount = Number(payment.amount || 0);
  const totalOrderAmount = totalFromLineItems > paidAmount ? totalFromLineItems : 0;
  const remainingBalance = totalOrderAmount > 0 ? Math.max(0, totalOrderAmount - paidAmount) : 0;

  return {
    ...payment,
    table_price: tableItem ? Number(tableItem.line_total || 0) : 0,
    menu_items: menuItems,
    line_items: items,
    ...(totalOrderAmount > 0 ? { total_order_amount: totalOrderAmount, remaining_balance: remainingBalance } : {}),
  };
}

async function createPayoutForPayment(conn, payment) {
  if (!payment.bar_id) return;

  const [existingPayout] = await conn.query(
    "SELECT id FROM payouts WHERE payment_transaction_id = ? LIMIT 1",
    [payment.id]
  );
  if (existingPayout.length) return;

  const [settings] = await conn.query(
    "SELECT setting_value FROM platform_settings WHERE setting_key = 'platform_fee_percentage' LIMIT 1"
  );
  const feePercentage = settings.length ? parseFloat(settings[0].setting_value) : 5.0;

  const grossAmount = Number(payment.amount || 0);
  const platformFeeAmount = (grossAmount * feePercentage) / 100;
  const netAmount = grossAmount - platformFeeAmount;

  const [bars] = await conn.query(
    "SELECT gcash_number, gcash_account_name FROM bars WHERE id = ? LIMIT 1",
    [payment.bar_id]
  );
  const [ownerRows] = await conn.query(
    `SELECT bo.id AS owner_id
     FROM bars b
     LEFT JOIN bar_owners bo ON bo.id = b.owner_id
     WHERE b.id = ?
     LIMIT 1`,
    [payment.bar_id]
  );

  await conn.query(
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

async function deductInventoryForReservation(conn, reservationId) {
  try {
    const [riCheck] = await conn.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reservation_items' LIMIT 1`
    );
    if (!riCheck.length) return;

    const [items] = await conn.query(
      `SELECT ri.menu_item_id, ri.quantity, m.inventory_item_id
       FROM reservation_items ri
       JOIN menu_items m ON m.id = ri.menu_item_id
       WHERE ri.reservation_id = ? AND m.inventory_item_id IS NOT NULL`,
      [reservationId]
    );

    for (const item of items) {
      const [invRows] = await conn.query(
        "SELECT stock_qty, reorder_level FROM inventory_items WHERE id = ? LIMIT 1",
        [item.inventory_item_id]
      );
      if (!invRows.length) continue;

      const newStock = Math.max(0, Number(invRows[0].stock_qty) - Number(item.quantity));
      let status = "normal";
      if (newStock <= 0) status = "critical";
      else if (newStock < Number(invRows[0].reorder_level || 0)) status = "low";

      await conn.query(
        "UPDATE inventory_items SET stock_qty = ?, stock_status = ? WHERE id = ?",
        [newStock, status, item.inventory_item_id]
      );
    }
  } catch (err) {
    console.error("DEDUCT INVENTORY (reservation) WARNING:", err.message);
  }
}

async function deductInventoryForOrder(conn, orderId) {
  try {
    const [items] = await conn.query(
      `SELECT poi.menu_item_id, poi.quantity, m.inventory_item_id
       FROM pos_order_items poi
       JOIN menu_items m ON m.id = poi.menu_item_id
       WHERE poi.order_id = ? AND m.inventory_item_id IS NOT NULL`,
      [orderId]
    );

    for (const item of items) {
      const [invRows] = await conn.query(
        "SELECT stock_qty, reorder_level FROM inventory_items WHERE id = ? LIMIT 1",
        [item.inventory_item_id]
      );
      if (!invRows.length) continue;

      const newStock = Math.max(0, Number(invRows[0].stock_qty) - Number(item.quantity));
      let status = "normal";
      if (newStock <= 0) status = "critical";
      else if (newStock < Number(invRows[0].reorder_level || 0)) status = "low";

      await conn.query(
        "UPDATE inventory_items SET stock_qty = ?, stock_status = ? WHERE id = ?",
        [newStock, status, item.inventory_item_id]
      );
    }
  } catch (err) {
    console.error("DEDUCT INVENTORY (order) WARNING:", err.message);
  }
}

async function markPaymentSuccess(conn, payment, paymongoPaymentId = null) {
  await conn.query(
    `UPDATE payment_transactions
     SET status = 'paid', paid_at = NOW(), paymongo_payment_id = COALESCE(?, paymongo_payment_id)
     WHERE id = ?`,
    [paymongoPaymentId, payment.id]
  );

  if (payment.payment_type === 'order') {
    await conn.query(
      "UPDATE pos_orders SET payment_status = 'paid', status = 'paid', completed_at = NOW() WHERE id = ?",
      [payment.related_id]
    );
    await deductInventoryForOrder(conn, payment.related_id);
  } else if (payment.payment_type === 'reservation') {
    const paidAmount = Number(payment.amount || 0);
    let newPaymentStatus = 'paid'; // safe default

    try {
      // Compute total from tables + reservation_items; fallback to payment_line_items
      let tableTotal = 0;
      try {
        const [[tableSumRow]] = await conn.query(
          `SELECT COALESCE(SUM(bt.price), 0) AS table_total
           FROM reservation_tables rt
           JOIN bar_tables bt ON bt.id = rt.table_id
           WHERE rt.reservation_id = ?`,
          [payment.related_id]
        );
        tableTotal = Number(tableSumRow?.table_total || 0);
      } catch (_) {}

      let itemsTotal = 0;
      try {
        const [[itemSumRow]] = await conn.query(
          `SELECT COALESCE(SUM(ri.quantity * ri.unit_price), 0) AS items_total
           FROM reservation_items ri
           WHERE ri.reservation_id = ?`,
          [payment.related_id]
        );
        itemsTotal = Number(itemSumRow?.items_total || 0);
      } catch (_) {}

      // Supplement with any items from notes not already represented in reservation_items
      try {
        const [[resNotes]] = await conn.query(
          `SELECT notes, bar_id FROM reservations WHERE id = ? LIMIT 1`,
          [payment.related_id]
        );
        if (resNotes?.notes) {
          const [dbItems] = await conn.query(
            `SELECT COALESCE(m.menu_name, '') AS menu_name
             FROM reservation_items ri2
             LEFT JOIN menu_items m ON m.id = ri2.menu_item_id
             WHERE ri2.reservation_id = ?`,
            [payment.related_id]
          );
          const dbNames = new Set(dbItems.map(i => (i.menu_name || '').toLowerCase().trim()).filter(Boolean));
          const parsedItems = parseReservationOrderItems(resNotes.notes);
          for (const it of parsedItems) {
            if (dbNames.has(it.name.toLowerCase().trim())) continue;
            const [menuRows] = await conn.query(
              `SELECT selling_price FROM menu_items WHERE bar_id = ? AND LOWER(menu_name) = LOWER(?) ORDER BY id DESC LIMIT 1`,
              [resNotes.bar_id, it.name]
            );
            const unitPrice = Number(menuRows[0]?.selling_price || 0);
            if (unitPrice > 0) itemsTotal += unitPrice * Number(it.quantity || 1);
          }
        }
      } catch (_) {}

      let computedTotal = tableTotal + itemsTotal;

      // Always consider payment_line_items total (captures full order breakdown from checkout)
      try {
        const [[pliSumRow]] = await conn.query(
          `SELECT COALESCE(SUM(line_total), 0) AS pli_total
           FROM payment_line_items
           WHERE payment_transaction_id = ?`,
          [payment.id]
        );
        computedTotal = Math.max(computedTotal, Number(pliSumRow?.pli_total || 0));
      } catch (_) {}

      let depositAmount = 0;
      try {
        const [[resRow]] = await conn.query(
          `SELECT deposit_amount FROM reservations WHERE id = ? LIMIT 1`,
          [payment.related_id]
        );
        depositAmount = Number(resRow?.deposit_amount || 0);
      } catch (_) {}

      const targetTotal = computedTotal > 0 ? computedTotal : depositAmount;
      newPaymentStatus = targetTotal > 0 && paidAmount < targetTotal ? 'partial' : 'paid';
    } catch (calcErr) {
      console.error('MARK_PAYMENT_CALC_ERR:', calcErr.message);
    }

    await conn.query(
      "UPDATE reservations SET payment_status = ?, status = 'confirmed', paid_at = NOW() WHERE id = ?",
      [newPaymentStatus, payment.related_id]
    );
    await deductInventoryForReservation(conn, payment.related_id);
  }

  await createPayoutForPayment(conn, payment);
}

async function markPaymentFailed(conn, payment, reason) {
  await conn.query(
    "UPDATE payment_transactions SET status = 'cancelled', failed_reason = ? WHERE id = ?",
    [reason || 'Payment cancelled', payment.id]
  );

  if (payment.payment_type === 'order') {
    await conn.query("UPDATE pos_orders SET payment_status = 'cancelled' WHERE id = ?", [payment.related_id]);
  } else if (payment.payment_type === 'reservation') {
    await conn.query(
      "UPDATE reservations SET payment_status = 'cancelled', status = 'cancelled' WHERE id = ? AND status NOT IN ('confirmed','cancelled')",
      [payment.related_id]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER PAYMENT ENDPOINTS (Orders, Reservations)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /payments/create — Create payment for order or reservation
 * Body: { payment_type, related_id, amount, payment_method, bar_id }
 */
router.post("/create", requireAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { payment_type, related_id, amount, payment_method, bar_id } = req.body;
    const userId = req.user.id;
    const relatedId = Number(related_id);
    const amountNum = Number(amount);

    // Validate input
    if (!payment_type || !['order', 'reservation'].includes(payment_type)) {
      return res.status(400).json({ success: false, message: "Invalid payment_type. Use 'order' or 'reservation'." });
    }
    if (!relatedId || !amountNum || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "related_id and amount are required." });
    }
    if (!Number.isFinite(amountNum) || amountNum > 1_000_000) {
      return res.status(400).json({ success: false, message: "Invalid payment amount." });
    }
    if (!payment_method || !['gcash', 'paymaya', 'card'].includes(payment_method)) {
      return res.status(400).json({ success: false, message: "Invalid payment_method. Use 'gcash', 'paymaya', or 'card'." });
    }

    // Verify the order/reservation exists and belongs to this user
    let verifyQuery = "";
    let verifyParams = [];
    let record = null;
    let derivedBarId = Number(bar_id || 0) || null;

    if (payment_type === 'order') {
      verifyQuery = `SELECT id, bar_id, table_id, total_amount, status, payment_status
                     FROM pos_orders
                     WHERE id = ?
                     LIMIT 1`;
      verifyParams = [relatedId];
    } else if (payment_type === 'reservation') {
      verifyQuery = `SELECT r.id, r.bar_id, r.table_id, r.customer_user_id, r.status, r.payment_status, r.notes,
                            t.table_number, t.price AS table_price
                     FROM reservations r
                     LEFT JOIN bar_tables t ON t.id = r.table_id
                     WHERE r.id = ? AND r.customer_user_id = ?
                     LIMIT 1`;
      verifyParams = [relatedId, userId];
    }

    const [records] = await pool.query(verifyQuery, verifyParams);
    if (!records.length) {
      return res.status(404).json({ success: false, message: `${payment_type} not found or does not belong to you.` });
    }
    record = records[0];
    if (!derivedBarId) {
      derivedBarId = Number(record.bar_id || 0) || null;
    }

    if (String(record.status || "").toLowerCase() === "cancelled") {
      return res.status(400).json({ success: false, message: "Cannot pay a cancelled record." });
    }

    // Check if payment already exists for this record
    const [existingPayments] = await pool.query(
      "SELECT id, status, checkout_url FROM payment_transactions WHERE payment_type = ? AND related_id = ? AND status IN ('pending', 'processing', 'paid') LIMIT 1",
      [payment_type, relatedId]
    );

    if (existingPayments.length) {
      const existing = existingPayments[0];
      if (existing.status === 'paid') {
        return res.status(400).json({ success: false, message: "This order/reservation is already paid." });
      }
      // Return existing pending payment
      return res.json({
        success: true,
        message: "Payment already created. Please complete the existing payment.",
        data: {
          payment_id: existing.id,
          status: existing.status,
          checkout_url: existing.checkout_url,
        },
      });
    }

    // Generate reference ID
    const referenceId = paymongoService.generateReferenceId(payment_type === 'order' ? 'ORD' : 'RES');

    // Create PayMongo source/payment
    let checkoutUrl = null;
    let paymongoSourceId = null;
    let paymongoPaymentIntentId = null;

    try {
      if (payment_method === 'gcash' || payment_method === 'paymaya') {
        const sourceType = payment_method === 'paymaya' ? 'grab_pay' : payment_method;
        
        // Use frontend-provided URLs or fallback to env (for backward compatibility)
        let successUrl = req.body.success_url || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/success?ref=${referenceId}`;
        let failedUrl = req.body.failed_url || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/failed?ref=${referenceId}`;
        
        // Replace placeholder with actual reference ID
        successUrl = successUrl.replace('{REFERENCE_ID}', referenceId);
        failedUrl = failedUrl.replace('{REFERENCE_ID}', referenceId);
        
        const source = await paymongoService.createSource(amount, sourceType, {
          description: `${payment_type === 'order' ? 'Order' : 'Reservation'} Payment #${relatedId}`,
          success_url: successUrl,
          failed_url: failedUrl,
        });
        checkoutUrl = source.attributes.redirect.checkout_url;
        paymongoSourceId = source.id;
      } else if (payment_method === 'card') {
        const intent = await paymongoService.createPaymentIntent(amount, {
          description: `${payment_type === 'order' ? 'Order' : 'Reservation'} Payment #${relatedId}`,
        });
        paymongoPaymentIntentId = intent.id;
        checkoutUrl = intent.attributes.next_action?.redirect?.url || null;
      }
    } catch (err) {
      console.error('PayMongo Error:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }

    await conn.beginTransaction();

    // Save payment transaction
    const [result] = await conn.query(
      `INSERT INTO payment_transactions 
       (reference_id, payment_type, related_id, bar_id, user_id, amount, status, payment_method, 
        paymongo_payment_intent_id, paymongo_source_id, checkout_url, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        referenceId,
        payment_type,
        relatedId,
        derivedBarId,
        userId,
        amountNum,
        payment_method,
        paymongoPaymentIntentId,
        paymongoSourceId,
        checkoutUrl,
        JSON.stringify({
          user_agent: req.headers['user-agent'],
          related_snapshot: {
            table_id: record.table_id || null,
            table_number: record.table_number || null,
            source_status: record.status || null,
            notes: record.notes || null,
          },
        }),
      ]
    );

    const paymentId = result.insertId;

    // Update order/reservation status to pending_payment
    if (payment_type === 'order') {
      await conn.query(
        "UPDATE pos_orders SET payment_status = 'pending', payment_transaction_id = ? WHERE id = ?",
        [paymentId, relatedId]
      );
    } else if (payment_type === 'reservation') {
      const hasPaymentTxCol = await hasReservationPaymentTransactionIdColumn(conn);
      if (hasPaymentTxCol) {
        await conn.query(
          `UPDATE reservations
           SET payment_status = 'pending', payment_method = ?, deposit_amount = ?, payment_reference = ?, payment_transaction_id = ?
           WHERE id = ?`,
          [payment_method, amountNum, referenceId, paymentId, relatedId]
        );
      } else {
        await conn.query(
          `UPDATE reservations
           SET payment_status = 'pending', payment_method = ?, deposit_amount = ?, payment_reference = ?
           WHERE id = ?`,
          [payment_method, amountNum, referenceId, relatedId]
        );
      }
    }

    let lineItems = [];
    if (payment_type === "order") {
      lineItems = await buildOrderLineItems(conn, relatedId);
    } else if (payment_type === "reservation") {
      lineItems = await buildReservationLineItems(conn, record);
    }
    await upsertPaymentLineItems(conn, paymentId, lineItems);

    await conn.commit();

    logAudit(null, {
      bar_id: derivedBarId || null,
      user_id: userId,
      action: "CREATE_PAYMENT",
      entity: "payment_transactions",
      entity_id: paymentId,
      details: { payment_type, related_id: relatedId, amount: amountNum, payment_method, line_items_count: lineItems.length },
      ...auditContext(req),
    });

    return res.json({
      success: true,
      message: "Payment created. Please complete the payment using the checkout URL.",
      data: {
        payment_id: paymentId,
        reference_id: referenceId,
        checkout_url: checkoutUrl,
        amount: amountNum,
        payment_method,
      },
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    console.error("CREATE PAYMENT ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  } finally {
    conn.release();
  }
});

/**
 * POST /payments/:reference_id/confirm — Confirm pending payment with PayMongo
 */
router.post("/:reference_id/confirm", requireAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { reference_id } = req.params;
    const userId = req.user.id;

    const [rows] = await conn.query(
      `SELECT *
       FROM payment_transactions
       WHERE reference_id = ? AND user_id = ?
       LIMIT 1`,
      [reference_id, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const payment = rows[0];
    if (payment.status === 'paid') {
      await conn.beginTransaction();
      await markPaymentSuccess(conn, payment, payment.paymongo_payment_id || null);
      await conn.commit();
      return res.json({ success: true, message: "Payment already confirmed", data: { status: 'paid', reference_id } });
    }

    if (payment.status === 'cancelled' || payment.status === 'failed') {
      await conn.beginTransaction();
      await markPaymentFailed(conn, payment, payment.failed_reason || 'Payment cancelled');
      await conn.commit();
      return res.json({ success: false, message: 'Payment cancelled', data: { status: 'cancelled', reference_id } });
    }

    await paymongoService.loadKeys();
    let externalStatus = null;
    let paymongoPaymentId = payment.paymongo_payment_id || null;

    if (payment.paymongo_source_id) {
      const source = await paymongoService.getSource(payment.paymongo_source_id);
      externalStatus = source?.attributes?.status || null;
      
      if (externalStatus === 'chargeable') {
        try {
          const attached = await paymongoService.attachSourceToPayment(payment.paymongo_source_id, {
            amount: Math.round(Number(payment.amount || 0) * 100),
            description: `Payment for ${payment.payment_type} #${payment.related_id}`,
          });
          paymongoPaymentId = attached?.id || paymongoPaymentId;
          externalStatus = 'paid';
        } catch (attachErr) {
          console.warn('Attach source error (may already be consumed):', attachErr.message);
          if (attachErr.message?.includes('not chargeable')) {
            externalStatus = source?.attributes?.status === 'consumed' ? 'paid' : externalStatus;
          } else {
            throw attachErr;
          }
        }
      } else if (externalStatus === 'consumed' || externalStatus === 'paid') {
        externalStatus = 'paid';
      }
    } else if (payment.paymongo_payment_intent_id) {
      const axios = require('axios');
      const response = await axios.get(
        `https://api.paymongo.com/v1/payment_intents/${payment.paymongo_payment_intent_id}`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(paymongoService.secretKey).toString('base64')}`,
          },
        }
      );
      externalStatus = response.data?.data?.attributes?.status || null;
      if (externalStatus === 'succeeded') externalStatus = 'paid';
    }

    await conn.beginTransaction();

    if (externalStatus === 'paid') {
      await markPaymentSuccess(conn, payment, paymongoPaymentId);
      await conn.commit();
      return res.json({ success: true, message: "Payment confirmed", data: { status: 'paid', reference_id } });
    }

    if (externalStatus === 'failed' || externalStatus === 'expired' || externalStatus === 'inactive') {
      await markPaymentFailed(conn, payment, 'Payment cancelled');
      await conn.commit();
      return res.json({ success: false, message: 'Payment cancelled', data: { status: 'cancelled', reference_id } });
    }

    await conn.query("UPDATE payment_transactions SET status = 'pending' WHERE id = ?", [payment.id]);
    await conn.commit();
    return res.json({ success: false, message: "Payment still pending", data: { status: externalStatus || 'pending', reference_id } });
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    console.error("CONFIRM PAYMENT ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to confirm payment" });
  } finally {
    conn.release();
  }
});

/**
 * POST /payments/cancel/:reference_id — Mark a pending payment as cancelled
 * Called when user lands on the PaymentFailed page (redirect from PayMongo)
 */
router.post("/cancel/:reference_id", requireAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { reference_id } = req.params;
    const userId = req.user.id;

    const [rows] = await conn.query(
      "SELECT * FROM payment_transactions WHERE reference_id = ? AND user_id = ? LIMIT 1",
      [reference_id, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const payment = rows[0];

    // Don't cancel an already-paid payment
    if (payment.status === 'paid') {
      return res.json({ success: true, message: "Payment already paid", data: { status: 'paid' } });
    }

    // Already cancelled — no-op
    if (payment.status === 'cancelled') {
      return res.json({ success: true, message: "Payment already cancelled", data: { status: 'cancelled' } });
    }

    await conn.beginTransaction();

    await conn.query(
      "UPDATE payment_transactions SET status = 'cancelled', failed_reason = 'Payment cancelled by user' WHERE id = ?",
      [payment.id]
    );

    if (payment.payment_type === 'order') {
      await conn.query("UPDATE pos_orders SET payment_status = 'cancelled' WHERE id = ?", [payment.related_id]);
    } else if (payment.payment_type === 'reservation') {
      await conn.query(
        "UPDATE reservations SET payment_status = 'cancelled', status = 'cancelled' WHERE id = ? AND status IN ('pending','approved')",
        [payment.related_id]
      );
    }

    await conn.commit();
    return res.json({ success: true, message: "Payment cancelled", data: { status: 'cancelled', reference_id } });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error("CANCEL PAYMENT ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  } finally {
    conn.release();
  }
});

/**
 * GET /payments/my/history — Get user's payment history with detailed breakdown
 */
router.get("/my/history", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, payment_type } = req.query;

    let where = "WHERE pt.user_id = ?";
    const params = [userId];

    if (status) {
      where += " AND pt.status = ?";
      params.push(status);
    }
    if (payment_type) {
      where += " AND pt.payment_type = ?";
      params.push(payment_type);
    }

    const [payments] = await pool.query(
      `SELECT pt.id, pt.reference_id, pt.payment_type, pt.related_id, pt.amount, pt.status, pt.payment_method,
              pt.paid_at, pt.created_at, pt.failed_reason,
              b.id AS bar_id, b.name AS bar_name,
              r.transaction_number, r.reservation_date, r.reservation_time, r.party_size, r.notes AS reservation_notes,
              r.status AS reservation_status, r.payment_status AS reservation_payment_status,
              COALESCE(rt.table_number, ot.table_number) AS table_number,
              o.order_number, o.status AS order_status
       FROM payment_transactions pt
       LEFT JOIN bars b ON b.id = pt.bar_id
       LEFT JOIN reservations r ON pt.payment_type = 'reservation' AND pt.related_id = r.id
       LEFT JOIN bar_tables rt ON rt.id = r.table_id
       LEFT JOIN pos_orders o ON pt.payment_type = 'order' AND pt.related_id = o.id
       LEFT JOIN bar_tables ot ON ot.id = o.table_id
       ${where}
       ORDER BY pt.created_at DESC
       LIMIT 100`,
      params
    );

    let lineItemsByPaymentId = new Map();
    if (payments.length && (await hasPaymentLineItemsTable(pool))) {
      const ids = payments.map((p) => p.id);
      const placeholders = ids.map(() => "?").join(",");
      const [lineItems] = await pool.query(
        `SELECT payment_transaction_id, item_type, item_name, quantity, unit_price, line_total, metadata
         FROM payment_line_items
         WHERE payment_transaction_id IN (${placeholders})
         ORDER BY id ASC`,
        ids
      );
      lineItemsByPaymentId = lineItems.reduce((acc, item) => {
        if (!acc.has(item.payment_transaction_id)) acc.set(item.payment_transaction_id, []);
        acc.get(item.payment_transaction_id).push(item);
        return acc;
      }, new Map());
    }

    return res.json({ success: true, data: payments.map((p) => normalizePaymentRow(p, lineItemsByPaymentId)) });
  } catch (err) {
    console.error("GET PAYMENT HISTORY ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * GET /payments/:reference_id — Get payment status/details by reference
 */
router.get("/:reference_id", requireAuth, async (req, res) => {
  try {
    const { reference_id } = req.params;
    const userId = req.user.id;

    const [payments] = await pool.query(
      `SELECT pt.id, pt.reference_id, pt.payment_type, pt.related_id, pt.amount, pt.status, pt.payment_method,
              pt.checkout_url, pt.paid_at, pt.failed_reason, pt.created_at,
              b.id AS bar_id, b.name AS bar_name,
              r.reservation_date, r.reservation_time, r.party_size, r.notes AS reservation_notes,
              COALESCE(rt.table_number, ot.table_number) AS table_number,
              o.order_number
       FROM payment_transactions pt
       LEFT JOIN bars b ON b.id = pt.bar_id
       LEFT JOIN reservations r ON pt.payment_type = 'reservation' AND pt.related_id = r.id
       LEFT JOIN bar_tables rt ON rt.id = r.table_id
       LEFT JOIN pos_orders o ON pt.payment_type = 'order' AND pt.related_id = o.id
       LEFT JOIN bar_tables ot ON ot.id = o.table_id
       WHERE pt.reference_id = ? AND pt.user_id = ?
       LIMIT 1`,
      [reference_id, userId]
    );

    if (!payments.length) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const payment = payments[0];
    let lineItemsByPaymentId = new Map();
    if (await hasPaymentLineItemsTable(pool)) {
      const [lineItems] = await pool.query(
        `SELECT payment_transaction_id, item_type, item_name, quantity, unit_price, line_total, metadata
         FROM payment_line_items
         WHERE payment_transaction_id = ?
         ORDER BY id ASC`,
        [payment.id]
      );
      lineItemsByPaymentId.set(payment.id, lineItems);
    }

    const normalized = normalizePaymentRow(payment, lineItemsByPaymentId);

    // For reservation payments, compute the true total order amount and remaining balance
    if (payment.payment_type === 'reservation' && payment.related_id) {
      try {
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
           FROM reservation_items ri WHERE ri.reservation_id = ?`,
          [payment.related_id]
        );
        let itemsTotal = Number(itemSumRow?.items_total || 0);

        // Supplement with notes items not already in reservation_items
        if (payment.reservation_notes) {
          const [[resBar]] = await pool.query(
            `SELECT bar_id FROM reservations WHERE id = ? LIMIT 1`,
            [payment.related_id]
          );
          const [dbItems] = await pool.query(
            `SELECT COALESCE(m.menu_name, '') AS menu_name
             FROM reservation_items ri2
             LEFT JOIN menu_items m ON m.id = ri2.menu_item_id
             WHERE ri2.reservation_id = ?`,
            [payment.related_id]
          );
          const dbNames = new Set(dbItems.map(i => (i.menu_name || '').toLowerCase().trim()).filter(Boolean));
          const parsedItems = parseReservationOrderItems(payment.reservation_notes);
          for (const it of parsedItems) {
            if (dbNames.has(it.name.toLowerCase().trim())) continue;
            const [menuRows] = await pool.query(
              `SELECT selling_price FROM menu_items WHERE bar_id = ? AND LOWER(menu_name) = LOWER(?) ORDER BY id DESC LIMIT 1`,
              [resBar?.bar_id, it.name]
            );
            const unitPrice = Number(menuRows[0]?.selling_price || 0);
            if (unitPrice > 0) itemsTotal += unitPrice * Number(it.quantity || 1);
          }
        }

        const totalOrderAmount = tableTotal + itemsTotal;
        if (totalOrderAmount > 0) {
          normalized.total_order_amount = totalOrderAmount;
          normalized.remaining_balance = Math.max(0, totalOrderAmount - Number(payment.amount || 0));
        }
      } catch (_) {}
    }

    return res.json({ success: true, data: normalized });
  } catch (err) {
    console.error("GET PAYMENT ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
