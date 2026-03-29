const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const requireAuth = require("../middlewares/requireAuth");
const requirePermission = require("../middlewares/requirePermission");
const { logAudit } = require("../utils/audit");
const { calculateAllDeductions } = require("../utils/deductionCalculator");

/**
 * GET PAYROLL SETTINGS
 * GET /hr/payroll/settings
 */
router.get(
  "/settings",
  requireAuth,
  requirePermission("payroll_view_all"),
  async (req, res) => {
    try {
      const barId = getBarIdOr403(req, res);
      if (!barId) return;

      const [rows] = await pool.query(
        `SELECT id, bar_id, sss_rate, philhealth_rate, pagibig_rate, 
                withholding_tax_rate, minimum_wage, updated_at
         FROM payroll_settings
         WHERE bar_id = ?
         LIMIT 1`,
        [barId]
      );

      if (rows.length === 0) {
        // Return default values if no settings exist yet
        return res.json({
          success: true,
          data: {
            bar_id: barId,
            sss_rate: 4.50,
            philhealth_rate: 3.00,
            pagibig_rate: 2.00,
            withholding_tax_rate: 0.00,
            minimum_wage: 610.00,
            updated_at: null
          }
        });
      }

      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("GET PAYROLL SETTINGS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/**
 * UPDATE PAYROLL SETTINGS
 * PUT /hr/payroll/settings
 */
router.put(
  "/settings",
  requireAuth,
  requirePermission("payroll_create"),
  async (req, res) => {
    try {
      const barId = getBarIdOr403(req, res);
      if (!barId) return;

      const {
        sss_rate,
        philhealth_rate,
        pagibig_rate,
        withholding_tax_rate,
        minimum_wage
      } = req.body;

      // Validate rates
      if (
        sss_rate == null ||
        philhealth_rate == null ||
        pagibig_rate == null ||
        withholding_tax_rate == null ||
        minimum_wage == null
      ) {
        return res.status(400).json({
          success: false,
          message: "All fields are required"
        });
      }

      // Check if settings exist
      const [existing] = await pool.query(
        "SELECT id FROM payroll_settings WHERE bar_id = ?",
        [barId]
      );

      if (existing.length > 0) {
        // Update existing settings
        await pool.query(
          `UPDATE payroll_settings
           SET sss_rate = ?, philhealth_rate = ?, pagibig_rate = ?,
               withholding_tax_rate = ?, minimum_wage = ?, updated_at = NOW()
           WHERE bar_id = ?`,
          [
            sss_rate,
            philhealth_rate,
            pagibig_rate,
            withholding_tax_rate,
            minimum_wage,
            barId
          ]
        );
      } else {
        // Insert new settings
        await pool.query(
          `INSERT INTO payroll_settings
           (bar_id, sss_rate, philhealth_rate, pagibig_rate,
            withholding_tax_rate, minimum_wage)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            barId,
            sss_rate,
            philhealth_rate,
            pagibig_rate,
            withholding_tax_rate,
            minimum_wage
          ]
        );
      }

      // Log audit
      await logAudit(
        barId,
        req.user.id,
        "UPDATE_PAYROLL_SETTINGS",
        "payroll_settings",
        existing.length > 0 ? existing[0].id : null,
        {
          sss_rate,
          philhealth_rate,
          pagibig_rate,
          withholding_tax_rate,
          minimum_wage
        }
      );

      return res.json({
        success: true,
        message: "Payroll settings updated successfully"
      });
    } catch (err) {
      console.error("UPDATE PAYROLL SETTINGS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/**
 * Helpers
 */
function getBarIdOr403(req, res) {
  const barId = req.user?.bar_id;
  if (barId === null || barId === undefined) {
    res.status(403).json({ success: false, message: "No bar_id on account" });
    return null;
  }
  return barId;
}

function isValidYMD(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toUTCts(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * (Optional) Payroll Preview
 * GET /hr/payroll/payroll?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Not required by runner, but kept from your original logic.
 */
router.get(
  "/payroll",
  requireAuth,
  requirePermission("payroll_view_all"),
  async (req, res) => {
    try {
      const barId = getBarIdOr403(req, res);
      if (barId === null) return;

      const { from, to } = req.query;
      if (!isValidYMD(from) || !isValidYMD(to)) {
        return res.status(400).json({
          success: false,
          message: "from and to required (YYYY-MM-DD)"
        });
      }

      const [rows] = await pool.query(
        `SELECT 
            u.id AS employee_user_id,
            CONCAT(u.first_name, ' ', u.last_name) AS name,
            COALESCE(ep.daily_rate, 0) AS daily_rate,
            SUM(CASE WHEN a.time_in IS NOT NULL THEN 1 ELSE 0 END) AS days_present,
            (COALESCE(ep.daily_rate, 0) * SUM(CASE WHEN a.time_in IS NOT NULL THEN 1 ELSE 0 END)) AS gross_pay
         FROM users u
         LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         LEFT JOIN attendance_logs a 
            ON a.employee_user_id = u.id
           AND a.bar_id = u.bar_id
           AND a.work_date BETWEEN ? AND ?
         WHERE u.bar_id = ? AND LOWER(u.role) = 'staff' AND u.is_active = 1
         GROUP BY u.id, ep.daily_rate, u.first_name, u.last_name
         ORDER BY u.last_name ASC, u.first_name ASC`,
        [from, to, barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("PAYROLL PREVIEW ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/**
 * CREATE PAYROLL RUN (DRAFT)
 * POST /hr/payroll/run
 * body: { period_start: 'YYYY-MM-DD', period_end: 'YYYY-MM-DD' }
 *
 * payroll_runs columns:
 * id, bar_id, period_start, period_end, status, created_by, created_at, finalized_at
 */
router.post(
  "/run",
  requireAuth,
  requirePermission("payroll_create"),
  async (req, res) => {
    try {
      const barId = getBarIdOr403(req, res);
      if (barId === null) return;

      const createdBy = req.user.id;
      const { period_start, period_end } = req.body || {};

      if (!isValidYMD(period_start) || !isValidYMD(period_end)) {
        return res.status(400).json({
          success: false,
          message: "period_start and period_end required (YYYY-MM-DD)"
        });
      }

      const startTs = toUTCts(period_start);
      const endTs = toUTCts(period_end);

      if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
        return res.status(400).json({ success: false, message: "Invalid date values" });
      }
      if (endTs < startTs) {
        return res.status(400).json({
          success: false,
          message: "Invalid period: period_end must be on/after period_start"
        });
      }

      const [result] = await pool.query(
        `INSERT INTO payroll_runs (bar_id, period_start, period_end, status, created_by)
         VALUES (?, ?, ?, 'draft', ?)`,
        [barId, period_start, period_end, createdBy]
      );

      // Runner expects data.id
      return res.status(201).json({
        success: true,
        data: { id: result.insertId }
      });
    } catch (err) {
      console.error("CREATE PAYROLL RUN ERROR:", err);

      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          success: false,
          message: "Duplicate payroll run for this period (same bar_id, period_start, period_end)."
        });
      }

      return res.status(500).json({
        success: false,
        message: err.sqlMessage || err.message || "Server error"
      });
    }
  }
);

/**
 * LIST PAYROLL RUNS
 * GET /hr/payroll/runs
 */
router.get(
  "/runs",
  requireAuth,
  requirePermission("payroll_view_all"),
  async (req, res) => {
    try {
      const barId = getBarIdOr403(req, res);
      if (barId === null) return;

      const { status, from, to } = req.query;

      const where = ["bar_id = ?"];
      const params = [barId];

      if (status) {
        where.push("status = ?");
        params.push(status); // draft|finalized
      }

      if (from && to) {
        where.push("period_start >= ? AND period_end <= ?");
        params.push(from, to);
      }

      const [rows] = await pool.query(
        `SELECT id, bar_id, period_start, period_end, status, created_by, created_at, finalized_at
         FROM payroll_runs
         WHERE ${where.join(" AND ")}
         ORDER BY id DESC
         LIMIT 200`,
        params
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("LIST PAYROLL RUNS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/**
 * GENERATE PAYROLL ITEMS FROM ATTENDANCE
 * POST /hr/payroll/runs/:id/generate
 *
 * Uses:
 * - users (role='staff')
 * - employee_profiles.daily_rate
 * - attendance_logs (days present)
 *
 * payroll_items expected columns (common):
 * payroll_run_id, bar_id, user_id, daily_rate, days_present, gross_pay, deductions, net_pay
 */
router.post(
  "/runs/:id/generate",
  requireAuth,
  requirePermission("payroll_create"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const barId = req.user?.bar_id;
      if (barId === null || barId === undefined) {
        return res.status(403).json({ success: false, message: "No bar_id on account" });
      }

      const runId = Number(req.params.id);
      if (!Number.isInteger(runId) || runId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid run id" });
      }

      await conn.beginTransaction();

      const [runs] = await conn.query(
        `SELECT id, bar_id, period_start, period_end, status
         FROM payroll_runs
         WHERE id=? AND bar_id=? LIMIT 1`,
        [runId, barId]
      );

      if (!runs.length) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: "Payroll run not found" });
      }

      const run = runs[0];

      if (run.status !== "draft") {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "Only draft payroll can be generated" });
      }

      // Safely format period dates as YYYY-MM-DD strings
      // mysql2 may return DATE columns as JS Date objects — timezone conversion can break BETWEEN
      function fmtDate(d) {
        if (!d) return null;
        if (typeof d === "string") return d.slice(0, 10);
        if (d instanceof Date) {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          return `${y}-${m}-${dd}`;
        }
        return String(d).slice(0, 10);
      }

      const periodStart = fmtDate(run.period_start);
      const periodEnd = fmtDate(run.period_end);

      if (!periodStart || !periodEnd || periodEnd < periodStart) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "Invalid payroll period dates" });
      }

      // delete existing items (safe regenerate)
      await conn.query(
        "DELETE FROM payroll_items WHERE payroll_run_id=? AND bar_id=?",
        [runId, barId]
      );

      // staff source (NO staff table)
      const [staff] = await conn.query(
        `SELECT 
            u.id AS user_id,
            COALESCE(ep.daily_rate, 0) AS daily_rate
         FROM users u
         LEFT JOIN employee_profiles ep ON ep.user_id = u.id AND ep.bar_id = u.bar_id
         WHERE u.bar_id = ?
           AND u.role != 'customer'
           AND u.is_active = 1`,
        [barId]
      );

      const generated = [];

      for (const s of staff) {
        const [att] = await conn.query(
          `SELECT COUNT(DISTINCT work_date) AS days_present
           FROM attendance_logs
           WHERE bar_id=?
             AND employee_user_id=?
             AND work_date BETWEEN ? AND ?
             AND time_in IS NOT NULL`,
          [barId, s.user_id, periodStart, periodEnd]
        );

        const days = Number(att[0]?.days_present || 0);
        const rate = Number(s.daily_rate || 0);
        const gross = rate * days;

        // Skip deduction calculation if employee has 0 days present
        let deductionResult;
        let totalDeductions = 0;
        
        if (days > 0) {
          // Calculate all deductions for this employee
          deductionResult = await calculateAllDeductions({
            barId,
            userId: s.user_id,
            grossPay: gross,
            dailyRate: rate,
            periodStart,
            periodEnd
          });
          totalDeductions = deductionResult.total;
        } else {
          // No deductions for 0 days present
          deductionResult = {
            bir: { enabled: false, amount: 0, computation: 'No work days' },
            sss: { enabled: false, amount: 0, computation: 'No work days' },
            philhealth: { enabled: false, amount: 0, computation: 'No work days' },
            late: { enabled: false, amount: 0, computation: 'No work days' },
            total: 0
          };
        }

        const net = Math.max(0, gross - totalDeductions);

        // Insert payroll item with detailed deduction breakdown
        const [insertResult] = await conn.query(
          `INSERT INTO payroll_items
            (payroll_run_id, bar_id, user_id, daily_rate,
             days_present, gross_pay, 
             bir_deduction, sss_deduction, philhealth_deduction, late_deduction,
             total_deductions, deductions, net_pay)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runId, barId, s.user_id, rate, days, gross,
            deductionResult.bir.amount,
            deductionResult.sss.amount,
            deductionResult.philhealth.amount,
            deductionResult.late.amount,
            totalDeductions,
            totalDeductions, // Keep old deductions column for compatibility
            net
          ]
        );

        const payrollItemId = insertResult.insertId;

        // Insert itemized deduction records for audit trail
        if (deductionResult.bir.enabled && deductionResult.bir.amount > 0) {
          await conn.query(
            `INSERT INTO payroll_deduction_items 
              (payroll_item_id, deduction_type, deduction_label, amount, is_enabled, computation_basis)
             VALUES (?, 'bir', 'BIR Withholding Tax', ?, 1, ?)`,
            [payrollItemId, deductionResult.bir.amount, deductionResult.bir.computation]
          );
        }

        if (deductionResult.sss.enabled && deductionResult.sss.amount > 0) {
          await conn.query(
            `INSERT INTO payroll_deduction_items 
              (payroll_item_id, deduction_type, deduction_label, amount, is_enabled, computation_basis)
             VALUES (?, 'sss', 'SSS Contribution', ?, 1, ?)`,
            [payrollItemId, deductionResult.sss.amount, deductionResult.sss.computation]
          );
        }

        if (deductionResult.philhealth.enabled && deductionResult.philhealth.amount > 0) {
          await conn.query(
            `INSERT INTO payroll_deduction_items 
              (payroll_item_id, deduction_type, deduction_label, amount, is_enabled, computation_basis)
             VALUES (?, 'philhealth', 'PhilHealth Contribution', ?, 1, ?)`,
            [payrollItemId, deductionResult.philhealth.amount, deductionResult.philhealth.computation]
          );
        }

        if (deductionResult.late.enabled && deductionResult.late.amount > 0) {
          await conn.query(
            `INSERT INTO payroll_deduction_items 
              (payroll_item_id, deduction_type, deduction_label, amount, is_enabled, computation_basis)
             VALUES (?, 'late', 'Late Deduction', ?, 1, ?)`,
            [payrollItemId, deductionResult.late.amount, deductionResult.late.computation]
          );
        }

        generated.push({ 
          user_id: s.user_id, 
          days_present: days, 
          gross_pay: gross,
          deductions: {
            bir: deductionResult.bir.amount,
            sss: deductionResult.sss.amount,
            philhealth: deductionResult.philhealth.amount,
            late: deductionResult.late.amount,
            total: totalDeductions
          },
          net_pay: net
        });
      }

      await conn.commit();
      return res.json({ success: true, message: "Payroll generated", generated });
    } catch (err) {
      await conn.rollback();
      console.error("GENERATE PAYROLL ERROR:", err);
      return res.status(500).json({ success: false, message: err.sqlMessage || err.message || "Server error" });
    } finally {
      conn.release();
    }
  }
);

/**
 * VIEW PAYROLL ITEMS
 * GET /hr/payroll/runs/:id/items
 */
router.get(
  "/runs/:id/items",
  requireAuth,
  requirePermission("payroll_view_all"),
  async (req, res) => {
    try {
      const barId = getBarIdOr403(req, res);
      if (barId === null) return;

      const runId = Number(req.params.id);
      if (!Number.isInteger(runId) || runId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid run id" });
      }

      const [runs] = await pool.query(
        `SELECT id, period_start, period_end, status, created_at, finalized_at
         FROM payroll_runs
         WHERE id=? AND bar_id=?
         LIMIT 1`,
        [runId, barId]
      );

      if (!runs.length) return res.status(404).json({ success: false, message: "Payroll run not found" });

      const [items] = await pool.query(
        `SELECT 
            pi.id,
            pi.user_id,
            u.first_name,
            u.last_name,
            u.email,
            pi.daily_rate,
            pi.days_present,
            pi.gross_pay,
            pi.bir_deduction,
            pi.sss_deduction,
            pi.philhealth_deduction,
            pi.late_deduction,
            pi.other_deductions,
            pi.total_deductions,
            pi.deductions,
            pi.net_pay
         FROM payroll_items pi
         JOIN users u ON u.id = pi.user_id
         WHERE pi.payroll_run_id=? AND pi.bar_id=?
         ORDER BY u.last_name ASC, u.first_name ASC`,
        [runId, barId]
      );

      // Get itemized deductions for each payroll item
      for (let item of items) {
        const [deductionItems] = await pool.query(
          `SELECT deduction_type, deduction_label, amount, computation_basis
           FROM payroll_deduction_items
           WHERE payroll_item_id = ? AND is_enabled = 1
           ORDER BY deduction_type`,
          [item.id]
        );
        item.deduction_items = deductionItems;
      }

      return res.json({ success: true, run: runs[0], items });
    } catch (err) {
      console.error("PAYROLL ITEMS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/**
 * FINALIZE PAYROLL RUN
 * PATCH /hr/payroll/runs/:id/finalize
 */
router.patch(
  "/runs/:id/finalize",
  requireAuth,
  requirePermission("payroll_create"),
  async (req, res) => {
    try {
      const barId = getBarIdOr403(req, res);
      if (barId === null) return;

      const runId = Number(req.params.id);
      if (!Number.isInteger(runId) || runId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid run id" });
      }

      const [runs] = await pool.query(
        "SELECT id, status FROM payroll_runs WHERE id=? AND bar_id=? LIMIT 1",
        [runId, barId]
      );

      if (!runs.length) return res.status(404).json({ success: false, message: "Payroll run not found" });

      if (runs[0].status !== "draft") {
        return res.status(400).json({ success: false, message: "Already finalized" });
      }

      await pool.query(
        "UPDATE payroll_runs SET status='finalized', finalized_at=NOW() WHERE id=? AND bar_id=?",
        [runId, barId]
      );

      return res.json({ success: true, message: "Payroll finalized" });
    } catch (err) {
      console.error("FINALIZE PAYROLL ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/**
 * CANCEL PAYROLL RUN (delete draft run)
 * DELETE /hr/payroll/runs/:id
 */
router.delete(
  "/runs/:id",
  requireAuth,
  requirePermission("payroll_create"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const barId = getBarIdOr403(req, res);
      if (barId === null) return;

      const runId = Number(req.params.id);
      if (!Number.isInteger(runId) || runId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid run id" });
      }

      await conn.beginTransaction();

      const [runs] = await conn.query(
        "SELECT id, status FROM payroll_runs WHERE id=? AND bar_id=? LIMIT 1",
        [runId, barId]
      );

      if (!runs.length) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: "Payroll run not found" });
      }

      if (runs[0].status !== "draft") {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "Only draft payroll can be cancelled" });
      }

      await conn.query("DELETE FROM payroll_items WHERE payroll_run_id=? AND bar_id=?", [runId, barId]);
      await conn.query("DELETE FROM payroll_runs WHERE id=? AND bar_id=?", [runId, barId]);

      await conn.commit();
      return res.json({ success: true, message: "Payroll run cancelled" });
    } catch (err) {
      await conn.rollback();
      console.error("CANCEL PAYROLL RUN ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      conn.release();
    }
  }
);

/**
 * EMPLOYEE: VIEW OWN PAYROLL
 * GET /hr/payroll/my-payroll
 */
router.get(
  "/my-payroll",
  requireAuth,
  requirePermission("payroll_view_own"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = req.user.id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [items] = await pool.query(
        `SELECT pi.id, pi.payroll_run_id, pi.user_id, pi.days_present, 
                pi.daily_rate, pi.gross_pay, 
                pi.bir_deduction, pi.sss_deduction, pi.philhealth_deduction, 
                pi.late_deduction, pi.other_deductions, pi.total_deductions,
                pi.deductions, pi.net_pay,
                pr.period_start, pr.period_end, pr.status AS run_status, pr.created_at
         FROM payroll_items pi
         JOIN payroll_runs pr ON pr.id = pi.payroll_run_id
         WHERE pi.bar_id = ? AND pi.user_id = ?
         ORDER BY pr.period_end DESC`,
        [barId, userId]
      );

      // Get itemized deductions for each payroll item
      for (let item of items) {
        const [deductionItems] = await pool.query(
          `SELECT deduction_type, deduction_label, amount, computation_basis
           FROM payroll_deduction_items
           WHERE payroll_item_id = ? AND is_enabled = 1
           ORDER BY deduction_type`,
          [item.id]
        );
        item.deduction_items = deductionItems;
      }

      return res.json({ success: true, items });
    } catch (err) {
      console.error("MY PAYROLL ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

module.exports = router;
