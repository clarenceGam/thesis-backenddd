// routes/leaveBalance.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

router.get("/leave/my-balance", requireAuth, requireRole("staff"), async (req, res) => {
  const barId = req.user.bar_id;
  const employeeUserId = req.user.id; // IMPORTANT: assuming your token user id = users.id
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ message: "Invalid year" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [types] = await conn.query(
      `SELECT id, code, name, default_annual_days
       FROM leave_types
       WHERE bar_id = ? AND is_active = 1
       ORDER BY code ASC`,
      [barId]
    );

    // Create missing balances
    for (const t of types) {
      await conn.query(
        `INSERT IGNORE INTO leave_balances
          (bar_id, employee_user_id, leave_type_id, year, allocated_days, used_days, carryover_days)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
        [barId, employeeUserId, t.id, year, t.default_annual_days]
      );
    }

    const [rows] = await conn.query(
      `SELECT
         lt.code,
         lt.name,
         lb.allocated_days,
         lb.carryover_days,
         lb.used_days,
         (lb.allocated_days + lb.carryover_days - lb.used_days) AS remaining_days
       FROM leave_balances lb
       JOIN leave_types lt ON lt.id = lb.leave_type_id
       WHERE lb.bar_id = ? AND lb.employee_user_id = ? AND lb.year = ?
       ORDER BY lt.code ASC`,
      [barId, employeeUserId, year]
    );

    await conn.commit();
    res.json({ year, balances: rows });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

module.exports = router;
