const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const requireAuth = require("../middlewares/requireAuth");

// Super-admin role gate (same pattern as superAdmin.js)
async function ensureSuperAdmin(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ? LIMIT 1`,
      [req.user.id]
    );
    if (rows[0]?.role_name !== "SUPER_ADMIN") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    req.user.role_name = rows[0].role_name;
    return next();
  } catch (err) {
    console.error("SUPER_ADMIN CHECK ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ═══════════════════════════════════════════
// GET /subscriptions/plans — list available plans
// ═══════════════════════════════════════════
router.get("/plans", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT sp.*,
              (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = sp.id AND s.status = 'active') AS active_subscriptions
       FROM subscription_plans sp
       WHERE sp.is_active = 1
       ORDER BY sp.sort_order ASC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET PLANS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// GET /subscriptions/my — get current user's subscription
// ═══════════════════════════════════════════
router.get("/my", requireAuth, async (req, res) => {
  try {
    const [owners] = await pool.query(
      "SELECT id, subscription_tier, subscription_expires_at FROM bar_owners WHERE user_id = ? LIMIT 1",
      [req.user.id]
    );
    if (!owners.length) return res.status(404).json({ success: false, message: "Bar owner not found" });

    const owner = owners[0];
    const [subs] = await pool.query(
      `SELECT s.*, sp.name AS plan_name, sp.display_name, sp.max_bars, sp.max_events, sp.max_promotions, sp.price, sp.billing_period
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_id = sp.id
       WHERE s.bar_owner_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
      [owner.id]
    );

    const activeSub = subs.length ? subs[0] : null;

    // Also check for a pending subscription
    const [pendingSubs] = await pool.query(
      `SELECT s.*, sp.name AS plan_name, sp.display_name, sp.max_bars, sp.max_events, sp.max_promotions, sp.price, sp.billing_period
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_id = sp.id
       WHERE s.bar_owner_id = ? AND s.status = 'pending'
       ORDER BY s.created_at DESC LIMIT 1`,
      [owner.id]
    );
    const pendingSub = pendingSubs.length ? pendingSubs[0] : null;

    // Count current usage
    const [barCount] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM bars WHERE owner_id = ? AND status != 'deleted'",
      [owner.id]
    );
    const [eventCount] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM bar_events be
       JOIN bars b ON be.bar_id = b.id
       WHERE b.owner_id = ? AND be.status = 'active'`,
      [owner.id]
    );
    const [promoCount] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM promotions p
       JOIN bars b ON p.bar_id = b.id
       WHERE b.owner_id = ? AND p.status = 'active'`,
      [owner.id]
    );

    return res.json({
      success: true,
      data: {
        subscription: activeSub,
        pending_subscription: pendingSub,
        tier: owner.subscription_tier || "free",
        expires_at: owner.subscription_expires_at,
        usage: {
          bars: barCount[0].cnt,
          events: eventCount[0].cnt,
          promotions: promoCount[0].cnt,
        },
      },
    });
  } catch (err) {
    console.error("GET MY SUBSCRIPTION ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// POST /subscriptions/subscribe — create/upgrade subscription
// ═══════════════════════════════════════════
router.post("/subscribe", requireAuth, async (req, res) => {
  try {
    const { plan_id, payment_method, payment_reference } = req.body;
    if (!plan_id) return res.status(400).json({ success: false, message: "Plan ID required" });

    const [plans] = await pool.query("SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1", [plan_id]);
    if (!plans.length) return res.status(404).json({ success: false, message: "Plan not found" });
    const plan = plans[0];

    const [owners] = await pool.query("SELECT id FROM bar_owners WHERE user_id = ? LIMIT 1", [req.user.id]);
    if (!owners.length) return res.status(404).json({ success: false, message: "Bar owner not found" });
    const ownerId = owners[0].id;

    // Cancel any existing pending subscription (replace with new request)
    await pool.query(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE bar_owner_id = ? AND status = 'pending'",
      [ownerId]
    );

    if (!payment_method) return res.status(400).json({ success: false, message: "Payment method required" });
    if (!payment_reference || !payment_reference.trim()) return res.status(400).json({ success: false, message: "Payment reference / transaction number required" });

    // Create subscription with status = 'pending' (awaits super admin approval)
    const [result] = await pool.query(
      `INSERT INTO subscriptions (bar_owner_id, plan_id, status, starts_at, expires_at, payment_method, payment_reference, amount_paid)
       VALUES (?, ?, 'pending', NOW(), NULL, ?, ?, ?)`,
      [ownerId, plan_id, payment_method, payment_reference.trim(), plan.price]
    );

    return res.json({
      success: true,
      message: `Payment submitted! Your ${plan.display_name} plan upgrade is pending admin approval.`,
      data: { subscription_id: result.insertId, plan: plan.name, status: "pending" },
    });
  } catch (err) {
    console.error("SUBSCRIBE ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// POST /subscriptions/cancel — cancel subscription
// ═══════════════════════════════════════════
router.post("/cancel", requireAuth, async (req, res) => {
  try {
    const [owners] = await pool.query("SELECT id FROM bar_owners WHERE user_id = ? LIMIT 1", [req.user.id]);
    if (!owners.length) return res.status(404).json({ success: false, message: "Bar owner not found" });
    const ownerId = owners[0].id;

    // Cancel both active and pending subscriptions
    await pool.query(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE bar_owner_id = ? AND status IN ('active', 'pending')",
      [ownerId]
    );

    // Revert to free tier
    await pool.query(
      "UPDATE bar_owners SET subscription_tier = 'free', subscription_expires_at = NULL WHERE id = ?",
      [ownerId]
    );

    // Lock all bars except the first one
    const [allBars] = await pool.query(
      "SELECT id FROM bars WHERE owner_id = ? ORDER BY created_at ASC",
      [ownerId]
    );
    for (let i = 0; i < allBars.length; i++) {
      const locked = i >= 1 ? 1 : 0;
      await pool.query("UPDATE bars SET is_locked = ? WHERE id = ?", [locked, allBars[i].id]);
    }

    return res.json({
      success: true,
      message: "Subscription cancelled. Reverted to Free plan.",
    });
  } catch (err) {
    console.error("CANCEL SUBSCRIPTION ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// SUPER ADMIN: PUT /subscriptions/admin/plans/:id — update plan price
// ═══════════════════════════════════════════
router.put("/admin/plans/:id", requireAuth, ensureSuperAdmin, async (req, res) => {
  try {
    const planId = parseInt(req.params.id);
    const { price } = req.body;

    if (price === undefined || price === null) {
      return res.status(400).json({ success: false, message: "Price is required" });
    }

    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) {
      return res.status(400).json({ success: false, message: "Invalid price value" });
    }

    const [plans] = await pool.query("SELECT * FROM subscription_plans WHERE id = ? LIMIT 1", [planId]);
    if (!plans.length) {
      return res.status(404).json({ success: false, message: "Plan not found" });
    }

    await pool.query(
      "UPDATE subscription_plans SET price = ?, updated_at = NOW() WHERE id = ?",
      [priceNum, planId]
    );

    return res.json({
      success: true,
      message: `Updated ${plans[0].display_name} price to ${priceNum}`,
      data: { plan_id: planId, new_price: priceNum }
    });
  } catch (err) {
    console.error("UPDATE PLAN PRICE ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// SUPER ADMIN: GET /subscriptions/admin/pending — list all pending subscriptions
// ═══════════════════════════════════════════
router.get("/admin/pending", requireAuth, ensureSuperAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.id, s.bar_owner_id, s.plan_id, s.status, s.payment_method, s.payment_reference,
              s.amount_paid, s.created_at,
              sp.name AS plan_name, sp.display_name AS plan_display_name, sp.price AS plan_price,
              sp.max_bars, sp.billing_period,
              u.first_name, u.last_name, u.email,
              bo.id AS owner_record_id
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_id = sp.id
       JOIN bar_owners bo ON s.bar_owner_id = bo.id
       JOIN users u ON bo.user_id = u.id
       WHERE s.status = 'pending'
       ORDER BY s.created_at ASC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET PENDING SUBSCRIPTIONS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// SUPER ADMIN: GET /subscriptions/admin/all — list all subscriptions (history)
// ═══════════════════════════════════════════
router.get("/admin/all", requireAuth, ensureSuperAdmin, async (req, res) => {
  try {
    const status = req.query.status; // optional filter
    let whereClause = "";
    const params = [];
    if (status) {
      whereClause = "WHERE s.status = ?";
      params.push(status);
    }
    const [rows] = await pool.query(
      `SELECT s.id, s.bar_owner_id, s.plan_id, s.status, s.payment_method, s.payment_reference,
              s.amount_paid, s.starts_at, s.expires_at, s.cancelled_at, s.created_at,
              sp.name AS plan_name, sp.display_name AS plan_display_name, sp.price AS plan_price,
              sp.max_bars, sp.billing_period,
              u.first_name, u.last_name, u.email
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_id = sp.id
       JOIN bar_owners bo ON s.bar_owner_id = bo.id
       JOIN users u ON bo.user_id = u.id
       ${whereClause}
       ORDER BY s.created_at DESC
       LIMIT 100`,
      params
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET ALL SUBSCRIPTIONS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// SUPER ADMIN: POST /subscriptions/admin/approve/:id — approve a pending subscription
// ═══════════════════════════════════════════
router.post("/admin/approve/:id", requireAuth, ensureSuperAdmin, async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);

    // Fetch the pending subscription
    const [subs] = await pool.query(
      `SELECT s.*, sp.name AS plan_name, sp.display_name, sp.max_bars, sp.billing_period
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_id = sp.id
       WHERE s.id = ? AND s.status = 'pending' LIMIT 1`,
      [subId]
    );
    if (!subs.length) {
      return res.status(404).json({ success: false, message: "Pending subscription not found" });
    }
    const sub = subs[0];

    // Calculate expiry from NOW (approval time)
    let expiresAt = null;
    if (sub.billing_period === "monthly") {
      expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    } else if (sub.billing_period === "yearly") {
      expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }

    // Cancel any existing active subscription for this owner
    await pool.query(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE bar_owner_id = ? AND status = 'active'",
      [sub.bar_owner_id]
    );

    // Activate the pending subscription
    await pool.query(
      "UPDATE subscriptions SET status = 'active', starts_at = NOW(), expires_at = ? WHERE id = ?",
      [expiresAt, subId]
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

    return res.json({
      success: true,
      message: `Approved ${sub.display_name} plan for owner #${sub.bar_owner_id}`,
      data: { subscription_id: subId, plan: sub.plan_name, expires_at: expiresAt },
    });
  } catch (err) {
    console.error("APPROVE SUBSCRIPTION ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// SUPER ADMIN: POST /subscriptions/admin/reject/:id — reject a pending subscription
// ═══════════════════════════════════════════
router.post("/admin/reject/:id", requireAuth, ensureSuperAdmin, async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);
    const { reason } = req.body;

    const [subs] = await pool.query(
      "SELECT id, bar_owner_id FROM subscriptions WHERE id = ? AND status = 'pending' LIMIT 1",
      [subId]
    );
    if (!subs.length) {
      return res.status(404).json({ success: false, message: "Pending subscription not found" });
    }

    await pool.query(
      "UPDATE subscriptions SET status = 'rejected', cancelled_at = NOW() WHERE id = ?",
      [subId]
    );

    return res.json({
      success: true,
      message: "Subscription request rejected.",
      data: { subscription_id: subId, reason: reason || null },
    });
  } catch (err) {
    console.error("REJECT SUBSCRIPTION ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
