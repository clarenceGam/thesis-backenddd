const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const requireAuth = require("../middlewares/requireAuth");
const requirePermission = require("../middlewares/requirePermission");
const { logAudit, auditContext } = require("../utils/audit");

// ═══════════════════════════════════════════════════
// POS MENU — fetch menu items for POS display
// ═══════════════════════════════════════════════════

router.get(
  "/menu",
  requireAuth,
  requirePermission("menu_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT m.id, m.inventory_item_id, m.menu_name, m.menu_description,
                m.selling_price, m.category, m.is_available, m.sort_order,
                i.name AS inventory_name, i.stock_qty, i.unit, i.cost_price,
                i.image_path, i.stock_status
         FROM menu_items m
         JOIN inventory_items i ON i.id = m.inventory_item_id
         WHERE m.bar_id = ? AND i.is_active = 1
         ORDER BY m.category ASC, m.sort_order ASC, m.menu_name ASC`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("POS MENU ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════════════
// POS TABLES — fetch tables for order assignment
// ═══════════════════════════════════════════════════

router.get(
  "/tables",
  requireAuth,
  requirePermission("menu_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [tables] = await pool.query(
        `SELECT id, table_number, capacity, is_active, image_path, price
         FROM bar_tables
         WHERE bar_id = ?
         ORDER BY table_number ASC`,
        [barId]
      );

      // Check which tables have active (pending) POS orders
      const [activeOrders] = await pool.query(
        `SELECT table_id, id AS order_id, order_number
         FROM pos_orders
         WHERE bar_id = ? AND status = 'pending' AND table_id IS NOT NULL`,
        [barId]
      );

      const activeMap = {};
      for (const o of activeOrders) {
        activeMap[o.table_id] = { order_id: o.order_id, order_number: o.order_number };
      }

      // Check which tables have reservations today
      const [reservations] = await pool.query(
        `SELECT table_id
         FROM reservations
         WHERE bar_id = ? AND reservation_date = CURDATE() AND status IN ('pending','approved')`,
        [barId]
      );
      const reservedSet = new Set(reservations.map(r => r.table_id));

      const data = tables.map(t => ({
        ...t,
        status: activeMap[t.id] ? "occupied" : (reservedSet.has(t.id) ? "reserved" : "available"),
        active_order: activeMap[t.id] || null,
      }));

      return res.json({ success: true, data });
    } catch (err) {
      console.error("POS TABLES ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════════════
// POS CREATE ORDER
// ═══════════════════════════════════════════════════

router.post(
  "/orders",
  requireAuth,
  requirePermission("reservation_manage"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const barId = req.user.bar_id;
      const staffId = req.user.id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const { table_id, items, notes, order_timestamp } = req.body || {};

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: "items array is required" });
      }

      await conn.beginTransaction();

      // Validate table if provided
      if (table_id) {
        const [tableRows] = await conn.query(
          "SELECT id, is_active FROM bar_tables WHERE id = ? AND bar_id = ? LIMIT 1",
          [table_id, barId]
        );
        if (!tableRows.length) {
          await conn.rollback();
          return res.status(404).json({ success: false, message: "Table not found" });
        }
        if (!tableRows[0].is_active) {
          await conn.rollback();
          return res.status(400).json({ success: false, message: "Table is inactive" });
        }
      }

      // Use client timestamp if provided (device time), otherwise server time (now in Asia/Manila)
      const orderDate = order_timestamp ? new Date(order_timestamp) : new Date();
      
      // Generate order number: POS-YYYYMMDD-NNN (based on order date)
      const dateStr = orderDate.toISOString().slice(0, 10).replace(/-/g, "");
      const [countRows] = await conn.query(
        "SELECT COUNT(*) AS cnt FROM pos_orders WHERE bar_id = ? AND DATE(created_at) = ?",
        [barId, orderDate.toISOString().slice(0, 10)]
      );
      const seq = String((countRows[0].cnt || 0) + 1).padStart(3, "0");
      const orderNumber = `POS-${dateStr}-${seq}`;

      // Validate items and compute totals
      let subtotal = 0;
      const orderItems = [];

      for (const item of items) {
        if (!item.menu_item_id || !item.quantity || item.quantity <= 0) {
          await conn.rollback();
          return res.status(400).json({ success: false, message: "Each item needs menu_item_id and quantity > 0" });
        }

        const [menuRows] = await conn.query(
          `SELECT m.id, m.menu_name, m.selling_price, m.inventory_item_id, m.is_available,
                  i.stock_qty
           FROM menu_items m
           JOIN inventory_items i ON i.id = m.inventory_item_id
           WHERE m.id = ? AND m.bar_id = ? LIMIT 1`,
          [item.menu_item_id, barId]
        );

        if (!menuRows.length) {
          await conn.rollback();
          return res.status(404).json({ success: false, message: `Menu item ${item.menu_item_id} not found` });
        }

        const mi = menuRows[0];
        if (!mi.is_available) {
          await conn.rollback();
          return res.status(400).json({ success: false, message: `${mi.menu_name} is not available` });
        }

        if (Number(mi.stock_qty) < item.quantity) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for ${mi.menu_name}. Available: ${mi.stock_qty}`
          });
        }

        const itemSubtotal = Number(mi.selling_price) * item.quantity;
        subtotal += itemSubtotal;

        orderItems.push({
          menu_item_id: mi.id,
          inventory_item_id: mi.inventory_item_id,
          item_name: mi.menu_name,
          unit_price: Number(mi.selling_price),
          quantity: item.quantity,
          subtotal: itemSubtotal,
          stock_qty: Number(mi.stock_qty),
          cost_price: Number(mi.cost_price || 0),
        });
      }

      const totalAmount = subtotal;

      // Insert order with client timestamp
      const [orderResult] = await conn.query(
        `INSERT INTO pos_orders (bar_id, table_id, staff_user_id, order_number, status, subtotal, total_amount, notes, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        [barId, table_id || null, staffId, orderNumber, subtotal, totalAmount, notes || null, orderDate]
      );
      const orderId = orderResult.insertId;

      // Insert order items
      for (const oi of orderItems) {
        await conn.query(
          `INSERT INTO pos_order_items (order_id, menu_item_id, inventory_item_id, item_name, unit_price, quantity, subtotal)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [orderId, oi.menu_item_id, oi.inventory_item_id, oi.item_name, oi.unit_price, oi.quantity, oi.subtotal]
        );
      }

      await conn.commit();

      logAudit(null, {
        bar_id: barId,
        user_id: staffId,
        action: "POS_CREATE_ORDER",
        entity: "pos_orders",
        entity_id: orderId,
        details: { order_number: orderNumber, table_id, item_count: orderItems.length, total: totalAmount },
        ...auditContext(req)
      });

      return res.status(201).json({
        success: true,
        message: "Order created",
        data: { id: orderId, order_number: orderNumber, total_amount: totalAmount }
      });
    } catch (err) {
      await conn.rollback();
      console.error("POS CREATE ORDER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      conn.release();
    }
  }
);

// ═══════════════════════════════════════════════════
// POS COMPLETE ORDER (Payment)
// ═══════════════════════════════════════════════════

router.post(
  "/orders/:id/pay",
  requireAuth,
  requirePermission("reservation_manage"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const barId = req.user.bar_id;
      const orderId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!orderId) return res.status(400).json({ success: false, message: "Invalid order id" });

      const { payment_method, amount_received, discount_amount } = req.body || {};

      if (!payment_method || !["cash", "digital"].includes(payment_method)) {
        return res.status(400).json({ success: false, message: "payment_method must be cash or digital" });
      }

      await conn.beginTransaction();

      // Get order
      const [orderRows] = await conn.query(
        "SELECT * FROM pos_orders WHERE id = ? AND bar_id = ? LIMIT 1",
        [orderId, barId]
      );
      if (!orderRows.length) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      const order = orderRows[0];
      if (order.status !== "pending") {
        await conn.rollback();
        return res.status(400).json({ success: false, message: `Order is already ${order.status}` });
      }

      const discount = Number(discount_amount || 0);
      const finalTotal = Number(order.subtotal) - discount;
      const received = Number(amount_received || finalTotal);
      const change = received - finalTotal;

      if (payment_method === "cash" && received < finalTotal) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "Insufficient payment amount" });
      }

      // Get order items for inventory deduction
      const [orderItems] = await conn.query(
        "SELECT * FROM pos_order_items WHERE order_id = ?",
        [orderId]
      );

      // Deduct inventory + record sales
      for (const oi of orderItems) {
        // Get current stock
        const [invRows] = await conn.query(
          "SELECT stock_qty, reorder_level, cost_price FROM inventory_items WHERE id = ? LIMIT 1",
          [oi.inventory_item_id]
        );
        if (!invRows.length) continue;

        const inv = invRows[0];
        const newStock = Number(inv.stock_qty) - oi.quantity;
        let stockStatus = "normal";
        if (newStock <= 0) stockStatus = "critical";
        else if (newStock < Number(inv.reorder_level)) stockStatus = "low";

        // Update inventory stock
        await conn.query(
          "UPDATE inventory_items SET stock_qty = ?, stock_status = ? WHERE id = ?",
          [Math.max(0, newStock), stockStatus, oi.inventory_item_id]
        );

        // Insert sales record (compatible with existing sales analytics)
        await conn.query(
          "INSERT INTO sales (bar_id, item_id, quantity, total_amount, sale_date) VALUES (?, ?, ?, ?, NOW())",
          [barId, oi.inventory_item_id, oi.quantity, Number(inv.cost_price || 0) * oi.quantity]
        );
      }

      // Update order
      await conn.query(
        `UPDATE pos_orders SET
           status = 'completed',
           payment_method = ?,
           discount_amount = ?,
           total_amount = ?,
           amount_received = ?,
           change_amount = ?,
           completed_at = NOW(),
           updated_at = NOW()
         WHERE id = ?`,
        [payment_method, discount, finalTotal, received, Math.max(0, change), orderId]
      );

      await conn.commit();

      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action: "POS_COMPLETE_ORDER",
        entity: "pos_orders",
        entity_id: orderId,
        details: { payment_method, total: finalTotal, received, change: Math.max(0, change) },
        ...auditContext(req)
      });

      return res.json({
        success: true,
        message: "Payment processed",
        data: {
          order_id: orderId,
          total_amount: finalTotal,
          amount_received: received,
          change_amount: Math.max(0, change),
          payment_method
        }
      });
    } catch (err) {
      await conn.rollback();
      console.error("POS PAY ORDER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      conn.release();
    }
  }
);

// ═══════════════════════════════════════════════════
// POS CANCEL ORDER
// ═══════════════════════════════════════════════════

router.post(
  "/orders/:id/cancel",
  requireAuth,
  requirePermission("reservation_manage"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const orderId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [orderRows] = await pool.query(
        "SELECT id, status FROM pos_orders WHERE id = ? AND bar_id = ? LIMIT 1",
        [orderId, barId]
      );
      if (!orderRows.length) return res.status(404).json({ success: false, message: "Order not found" });
      if (orderRows[0].status !== "pending") {
        return res.status(400).json({ success: false, message: `Cannot cancel a ${orderRows[0].status} order` });
      }

      await pool.query(
        "UPDATE pos_orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = ?",
        [orderId]
      );

      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action: "POS_CANCEL_ORDER",
        entity: "pos_orders",
        entity_id: orderId,
        details: {},
        ...auditContext(req)
      });

      return res.json({ success: true, message: "Order cancelled" });
    } catch (err) {
      console.error("POS CANCEL ORDER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════════════
// POS ORDER LIST (history) — merges pos_orders + legacy sales
// ═══════════════════════════════════════════════════

router.get(
  "/orders",
  requireAuth,
  requirePermission("reservation_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const { status, from, to, limit: lim } = req.query;
      const rowLimit = Math.min(Number(lim) || 100, 500);

      // --- 1) POS orders ---
      const posWhere = ["o.bar_id = ?"];
      const posParams = [barId];
      if (status) { posWhere.push("o.status = ?"); posParams.push(status); }
      if (from) { posWhere.push("DATE(o.created_at) >= ?"); posParams.push(from); }
      if (to) { posWhere.push("DATE(o.created_at) <= ?"); posParams.push(to); }

      const [posOrders] = await pool.query(
        `SELECT o.id, o.order_number, o.table_id, t.table_number,
                o.staff_user_id, CONCAT(u.first_name, ' ', u.last_name) AS staff_name,
                o.status, o.subtotal, o.discount_amount, o.total_amount,
                o.payment_method, o.amount_received, o.change_amount,
                o.notes, o.completed_at, o.cancelled_at, o.created_at
         FROM pos_orders o
         LEFT JOIN bar_tables t ON t.id = o.table_id
         LEFT JOIN users u ON u.id = o.staff_user_id
         WHERE ${posWhere.join(" AND ")}
         ORDER BY o.created_at DESC
         LIMIT ?`,
        [...posParams, rowLimit]
      );

      // --- 2) Legacy sales (from sales table, grouped by sale_date) ---
      // Only include sales from dates that have NO POS orders (to avoid double-counting)
      let legacySales = [];
      if (!status || status === "completed") {
        const legWhere = ["s.bar_id = ?"];
        const legParams = [barId];
        if (from) { legWhere.push("DATE(s.sale_date) >= ?"); legParams.push(from); }
        if (to) { legWhere.push("DATE(s.sale_date) <= ?"); legParams.push(to); }
        
        // Exclude dates that already have POS orders
        legWhere.push(`NOT EXISTS (
          SELECT 1 FROM pos_orders po 
          WHERE po.bar_id = s.bar_id 
          AND DATE(po.created_at) = DATE(s.sale_date)
        )`);

        const [rows] = await pool.query(
          `SELECT
             MIN(s.id) AS id,
             CONCAT('SALE-', DATE(MIN(s.sale_date))) AS order_number,
             NULL AS table_id, NULL AS table_number,
             NULL AS staff_user_id, 'Web / Manual' AS staff_name,
             'completed' AS status,
             COALESCE(SUM(COALESCE(m.selling_price * s.quantity, s.total_amount)), 0) AS subtotal,
             0 AS discount_amount,
             COALESCE(SUM(COALESCE(m.selling_price * s.quantity, s.total_amount)), 0) AS total_amount,
             'legacy' AS payment_method,
             0 AS amount_received, 0 AS change_amount,
             NULL AS notes,
             MAX(s.sale_date) AS completed_at,
             NULL AS cancelled_at,
             MAX(s.sale_date) AS created_at
           FROM sales s
           LEFT JOIN menu_items m ON m.inventory_item_id = s.item_id AND m.bar_id = s.bar_id
           WHERE ${legWhere.join(" AND ")}
           GROUP BY DATE(s.sale_date)
           ORDER BY DATE(s.sale_date) DESC
           LIMIT ?`,
          [...legParams, rowLimit]
        );
        legacySales = rows;
      }

      // --- 3) Merge & sort by date descending ---
      const all = [...posOrders, ...legacySales];
      all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      return res.json({ success: true, data: all.slice(0, rowLimit) });
    } catch (err) {
      console.error("POS ORDERS LIST ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════════════
// POS ORDER DETAIL (with items)
// ═══════════════════════════════════════════════════

router.get(
  "/orders/:id",
  requireAuth,
  requirePermission("reservation_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const orderId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [orderRows] = await pool.query(
        `SELECT o.*, t.table_number, CONCAT(u.first_name, ' ', u.last_name) AS staff_name
         FROM pos_orders o
         LEFT JOIN bar_tables t ON t.id = o.table_id
         LEFT JOIN users u ON u.id = o.staff_user_id
         WHERE o.id = ? AND o.bar_id = ? LIMIT 1`,
        [orderId, barId]
      );
      if (!orderRows.length) return res.status(404).json({ success: false, message: "Order not found" });

      const [items] = await pool.query(
        `SELECT oi.*, i.image_path
         FROM pos_order_items oi
         LEFT JOIN inventory_items i ON i.id = oi.inventory_item_id
         WHERE oi.order_id = ?`,
        [orderId]
      );

      return res.json({ success: true, data: { ...orderRows[0], items } });
    } catch (err) {
      console.error("POS ORDER DETAIL ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════════════
// POS DASHBOARD SUMMARY — uses sales table as single source of truth
// ═══════════════════════════════════════════════════

router.get(
  "/dashboard",
  requireAuth,
  requirePermission("menu_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      // Today's revenue from sales table (captures both web + POS sales)
      const [todaySales] = await pool.query(
        `SELECT
           COUNT(DISTINCT s.sale_date) AS completed_count,
           COALESCE(SUM(COALESCE(m.selling_price * s.quantity, s.total_amount)), 0) AS revenue
         FROM sales s
         LEFT JOIN menu_items m ON m.inventory_item_id = s.item_id AND m.bar_id = s.bar_id
         WHERE s.bar_id = ? AND DATE(s.sale_date) = CURDATE()`,
        [barId]
      );

      // Pending POS orders count
      const [pendingRows] = await pool.query(
        `SELECT
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
           SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled_count
         FROM pos_orders
         WHERE bar_id = ? AND DATE(created_at) = CURDATE()`,
        [barId]
      );

      // Weekly revenue from sales table
      const [weekSales] = await pool.query(
        `SELECT
           COALESCE(SUM(COALESCE(m.selling_price * s.quantity, s.total_amount)), 0) AS revenue,
           COUNT(DISTINCT s.sale_date) AS order_count
         FROM sales s
         LEFT JOIN menu_items m ON m.inventory_item_id = s.item_id AND m.bar_id = s.bar_id
         WHERE s.bar_id = ? AND YEARWEEK(s.sale_date, 1) = YEARWEEK(CURDATE(), 1)`,
        [barId]
      );

      // Top selling items today from sales table
      const [topItems] = await pool.query(
        `SELECT i.name AS item_name, SUM(s.quantity) AS total_qty,
                COALESCE(SUM(COALESCE(m.selling_price * s.quantity, s.total_amount)), 0) AS total_revenue
         FROM sales s
         JOIN inventory_items i ON i.id = s.item_id
         LEFT JOIN menu_items m ON m.inventory_item_id = s.item_id AND m.bar_id = s.bar_id
         WHERE s.bar_id = ? AND DATE(s.sale_date) = CURDATE()
         GROUP BY s.item_id, i.name
         ORDER BY total_qty DESC
         LIMIT 5`,
        [barId]
      );

      // Low stock alerts
      const [lowStock] = await pool.query(
        `SELECT id, name, stock_qty, reorder_level, stock_status
         FROM inventory_items
         WHERE bar_id = ? AND is_active = 1 AND stock_status IN ('low','critical')
         ORDER BY stock_qty ASC
         LIMIT 10`,
        [barId]
      );

      return res.json({
        success: true,
        data: {
          today: {
            revenue: todaySales[0].revenue,
            completed_count: todaySales[0].completed_count,
            pending_count: pendingRows[0].pending_count || 0,
            cancelled_count: pendingRows[0].cancelled_count || 0,
          },
          week: weekSales[0],
          top_items: topItems,
          low_stock: lowStock,
        }
      });
    } catch (err) {
      console.error("POS DASHBOARD ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

module.exports = router;
