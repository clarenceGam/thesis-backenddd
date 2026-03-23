const express = require("express");
const router = express.Router();

const pool = require("../config/database");
const requireAuth = require("../middlewares/requireAuth");
const requirePermission = require("../middlewares/requirePermission");
const { logAudit, auditContext } = require("../utils/audit");

function todayYYYYMMDD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

router.post("/employee/attendance", requireAuth, requirePermission("attendance_view_own"), async (req, res) => {
  try {
    const barId = req.user.bar_id;
    if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

    const userId = req.user.id;
    const workDate = todayYYYYMMDD();
    const { action } = req.body || {}; // "clock_in" | "clock_out"
    
    if (!action || !["clock_in", "clock_out"].includes(action)) {
      return res.status(400).json({ success: false, message: "Invalid action. Use 'clock_in' or 'clock_out'." });
    }

    // ── SECURITY: Full employee status validation ──
    const [me] = await pool.query(
      `SELECT u.id, u.bar_id, u.role, u.is_active,
              ep.employment_status
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.id=? LIMIT 1`,
      [userId]
    );
    if (!me.length) return res.status(404).json({ success: false, message: "User not found" });
    if (me[0].bar_id !== barId) return res.status(403).json({ success: false, message: "Forbidden" });

    // Block inactive accounts
    if (!me[0].is_active) {
      logAudit(null, {
        bar_id: barId, user_id: userId, action: "BLOCKED_ATTENDANCE",
        entity: "attendance", details: { reason: "account_inactive", attempted_action: action },
        ...auditContext(req)
      });
      return res.status(403).json({ success: false, message: "Account is inactive. Cannot record attendance." });
    }

    // Block non-staff/hr/employee roles from clocking in (customers, bar_owners should not clock)
    const allowedClockRoles = ["staff", "hr", "employee"];
    if (!allowedClockRoles.includes((me[0].role || "").toLowerCase())) {
      logAudit(null, {
        bar_id: barId, user_id: userId, action: "BLOCKED_ATTENDANCE",
        entity: "attendance", details: { reason: "invalid_role", role: me[0].role, attempted_action: action },
        ...auditContext(req)
      });
      return res.status(403).json({ success: false, message: "Your role is not eligible for attendance clock." });
    }

    // Check for approved leave on this date — warn but don't hard-block
    const [leaveToday] = await pool.query(
      `SELECT id FROM leave_requests
       WHERE bar_id=? AND employee_user_id=? AND status='approved'
         AND ? BETWEEN start_date AND end_date
       LIMIT 1`,
      [barId, userId, workDate]
    );
    if (leaveToday.length) {
      logAudit(null, {
        bar_id: barId, user_id: userId, action: "ATTENDANCE_ON_LEAVE_DAY",
        entity: "attendance", details: { leave_request_id: leaveToday[0].id, work_date: workDate, attempted_action: action },
        ...auditContext(req)
      });
    }

    if (action === "clock_in") {
      // Prevent duplicate open sessions for the same day.
      const [openRows] = await pool.query(
        `SELECT id
         FROM attendance_logs
         WHERE bar_id=? AND employee_user_id=? AND work_date=?
           AND time_in IS NOT NULL AND time_out IS NULL
         ORDER BY id DESC
         LIMIT 1`,
        [barId, userId, workDate]
      );

      if (openRows.length) {
        logAudit(null, {
          bar_id: barId, user_id: userId, action: "DUPLICATE_CLOCK_IN",
          entity: "attendance", entity_id: openRows[0].id,
          details: { work_date: workDate, existing_log_id: openRows[0].id },
          ...auditContext(req)
        });
        return res.status(400).json({ success: false, message: "Already timed in" });
      }

      await pool.query(
        `INSERT INTO attendance_logs (bar_id, employee_user_id, work_date, time_in, source)
         VALUES (?, ?, ?, NOW(), 'manual')`,
        [barId, userId, workDate]
      );

      return res.json({ success: true, message: "Time in recorded", data: { work_date: workDate } });
    } else {
      // time-out
      const [rows] = await pool.query(
        `SELECT id, time_in, time_out
         FROM attendance_logs
         WHERE bar_id=? AND employee_user_id=? AND work_date=?
           AND time_in IS NOT NULL AND time_out IS NULL
         ORDER BY id DESC
         LIMIT 1`,
        [barId, userId, workDate]
      );

      if (!rows.length || !rows[0].time_in) {
        logAudit(null, {
          bar_id: barId, user_id: userId, action: "CLOCK_OUT_NO_CLOCK_IN",
          entity: "attendance",
          details: { work_date: workDate },
          ...auditContext(req)
        });
        return res.status(400).json({ success: false, message: "No time-in found for today" });
      }

      const [updateResult] = await pool.query(
        "UPDATE attendance_logs SET time_out = NOW() WHERE id = ? AND time_out IS NULL",
        [rows[0].id]
      );

      if (updateResult.affectedRows === 0) {
        return res.status(400).json({ success: false, message: "Already timed out" });
      }

      return res.json({ success: true, message: "Time out recorded", data: { work_date: workDate } });
    }
  } catch (err) {
    // Handle duplicate entry gracefully
    if (err.code === 'ER_DUP_ENTRY') {
      logAudit(null, {
        bar_id: req.user?.bar_id, user_id: req.user?.id, action: "DUPLICATE_ATTENDANCE_ENTRY",
        entity: "attendance", details: { error: "ER_DUP_ENTRY" },
        ...auditContext(req)
      });
      return res.status(409).json({
        success: false,
        message: "You already have an attendance record for today."
      });
    }
    console.error("ATTENDANCE CREATE ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// HR/Owner: Create attendance record for an employee
router.post("/hr/attendance", requireAuth, requirePermission("attendance_view_all"), async (req, res) => {
  try {
    const barId = req.user.bar_id;
    if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

    const { employee_user_id, work_date, time_in, time_out } = req.body || {};
    if (!employee_user_id || !work_date || !time_in) {
      return res.status(400).json({ success: false, message: "employee_user_id, work_date, and time_in are required" });
    }

    // Verify employee belongs to same bar
    const [emp] = await pool.query("SELECT id, bar_id FROM users WHERE id=? AND bar_id=? LIMIT 1", [employee_user_id, barId]);
    if (!emp.length) return res.status(404).json({ success: false, message: "Employee not found in your bar" });

    const [result] = await pool.query(
      `INSERT INTO attendance_logs (bar_id, employee_user_id, work_date, time_in, time_out, source)
       VALUES (?, ?, ?, ?, ?, 'manual')`,
      [barId, employee_user_id, work_date, time_in, time_out || null]
    );

    logAudit(null, {
      bar_id: barId, user_id: req.user.id, action: "HR_CREATE_ATTENDANCE",
      entity: "attendance", entity_id: result.insertId,
      details: { employee_user_id, work_date },
      ...auditContext(req)
    });

    return res.status(201).json({ success: true, message: "Attendance record created", data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: "Duplicate attendance record for this date" });
    }
    console.error("HR CREATE ATTENDANCE ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get(
  "/my/attendance",
  requireAuth,
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = req.user.id;
      if (barId === null || barId === undefined) {
        return res.status(403).json({ success: false, message: "No bar_id on account" });
      }

      const { from, to, start_date, end_date } = req.query;
      const fromDate = from || start_date || todayYYYYMMDD();
      const toDate = to || end_date || todayYYYYMMDD();

      const [rows] = await pool.query(
        `SELECT id, work_date, time_in, time_out, minutes_late, minutes_undertime, minutes_overtime
         FROM attendance_logs
         WHERE bar_id = ? AND employee_user_id = ? AND work_date BETWEEN ? AND ?
         ORDER BY work_date DESC, id DESC`,
        [barId, userId, fromDate, toDate]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("MY ATTENDANCE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.get(
  "/hr/attendance",
  requireAuth,
  requirePermission("attendance_view_all"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (barId === null || barId === undefined) {
        return res.status(403).json({ success: false, message: "No bar_id on account" });
      }

      const { from, to, employee_user_id, start_date, end_date } = req.query;
      const fromDate = from || start_date;
      const toDate = to || end_date;

      if (!fromDate || !toDate) {
        return res.status(400).json({ success: false, message: "from and to required (YYYY-MM-DD)" });
      }

      const params = [barId, fromDate, toDate];
      let extra = "";

      if (employee_user_id) {
        extra = " AND a.employee_user_id = ? ";
        params.push(Number(employee_user_id));
      }

      const [rows] = await pool.query(
        `SELECT a.id, a.work_date, a.time_in, a.time_out, a.minutes_late, a.minutes_undertime, a.minutes_overtime,
                u.first_name, u.last_name, u.email
         FROM attendance_logs a
         JOIN users u ON u.id = a.employee_user_id
         WHERE a.bar_id = ? AND a.work_date BETWEEN ? AND ? ${extra}
         ORDER BY a.work_date DESC, u.last_name ASC`,
        params
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("HR ATTENDANCE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);


router.patch("/hr/attendance/:id", requireAuth, requirePermission("attendance_view_all"), async (req, res) => {
  try {
    const barId = req.user.bar_id;
    if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    // SECURITY: work_date is immutable — prevent changing which day a record belongs to
    if (req.body.work_date !== undefined || req.body.employee_user_id !== undefined || req.body.bar_id !== undefined) {
      logAudit(null, {
        bar_id: barId, user_id: req.user.id, action: "ATTENDANCE_TAMPER_ATTEMPT",
        entity: "attendance", entity_id: id,
        details: { attempted_fields: Object.keys(req.body) },
        ...auditContext(req)
      });
      return res.status(400).json({ success: false, message: "Cannot modify work_date, employee_user_id, or bar_id" });
    }

    const { time_in, time_out, minutes_late, minutes_undertime, minutes_overtime } = req.body || {};

    // SECURITY: Validate datetime strings if provided
    const datetimeRx = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
    if (time_in !== undefined && time_in !== null && !datetimeRx.test(String(time_in))) {
      return res.status(400).json({ success: false, message: "Invalid time_in format (YYYY-MM-DD HH:MM:SS)" });
    }
    if (time_out !== undefined && time_out !== null && !datetimeRx.test(String(time_out))) {
      return res.status(400).json({ success: false, message: "Invalid time_out format (YYYY-MM-DD HH:MM:SS)" });
    }

    // Build dynamic update query
    const updates = [];
    const params = [];

    if (time_in !== undefined) {
      updates.push("time_in = ?");
      params.push(time_in);
    }
    if (time_out !== undefined) {
      updates.push("time_out = ?");
      params.push(time_out);
    }
    if (minutes_late !== undefined) {
      updates.push("minutes_late = ?");
      params.push(Number(minutes_late));
    }
    if (minutes_undertime !== undefined) {
      updates.push("minutes_undertime = ?");
      params.push(Number(minutes_undertime));
    }
    if (minutes_overtime !== undefined) {
      updates.push("minutes_overtime = ?");
      params.push(Number(minutes_overtime));
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    updates.push("updated_at = NOW()");
    params.push(id, barId);

    const [result] = await pool.query(
      `UPDATE attendance_logs SET ${updates.join(", ")} WHERE id = ? AND bar_id = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Attendance record not found" });
    }

    // Audit the successful update
    logAudit(null, {
      bar_id: barId, user_id: req.user.id, action: "ATTENDANCE_MANUAL_UPDATE",
      entity: "attendance", entity_id: id,
      details: { updated_fields: Object.keys(req.body) },
      ...auditContext(req)
    });

    return res.json({ success: true, message: "Attendance record updated" });
  } catch (err) {
    console.error("HR ATTENDANCE UPDATE ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
