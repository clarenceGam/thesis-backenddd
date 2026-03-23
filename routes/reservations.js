const express = require("express");
const router = express.Router();

const pool = require("../config/database");
const requireAuth = require("../middlewares/requireAuth");
const requireRole = require("../middlewares/requireRole");
const requirePermission = require("../middlewares/requirePermission");
const { USER_ROLES } = require("../config/constants");
const { logAudit, auditContext } = require("../utils/audit");
const jwt = require("jsonwebtoken");

function generateTransactionNumber() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 6; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return `RES-${date}-${rand}`;
}

let _hasReservationModeColumnCache = null;
async function hasReservationModeColumn() {
  if (_hasReservationModeColumnCache !== null) return _hasReservationModeColumnCache;
  try {
    const [rows] = await pool.query(
      `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'bars'
         AND COLUMN_NAME = 'reservation_mode'
       LIMIT 1`
    );
    _hasReservationModeColumnCache = rows.length > 0;
  } catch (_) {
    _hasReservationModeColumnCache = false;
  }
  return _hasReservationModeColumnCache;
}

function normalizeReservationHourInput(rawTime) {
  if (!rawTime) return null;
  const str = String(rawTime).trim();
  const match = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh < 0 || hh > 23 || mm !== 0) return null;
  return `${String(hh).padStart(2, "0")}:00:00`;
}

function parseClockToMinutes(token) {
  if (!token) return null;
  const cleaned = String(token).trim().toLowerCase();
  const m = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2] || 0);
  const meridiem = m[3] ? m[3].toLowerCase() : null;
  if (mm < 0 || mm > 59) return null;

  if (meridiem) {
    if (hh < 1 || hh > 12) return null;
    if (meridiem === "am") {
      if (hh === 12) hh = 0;
    } else if (meridiem === "pm") {
      if (hh !== 12) hh += 12;
    }
  } else if (hh < 0 || hh > 23) {
    return null;
  }

  return hh * 60 + mm;
}

function parseBusinessHoursWindow(hoursText) {
  if (!hoursText) return null;
  const raw = String(hoursText).trim();
  if (!raw) return null;
  if (["closed", "n/a", "na", "off"].includes(raw.toLowerCase())) return null;

  const normalized = raw.replace(/\s+to\s+/gi, " - ");
  const range = normalized.match(/(.+?)\s*-\s*(.+)/);
  if (!range) return null;

  const start = parseClockToMinutes(range[1]);
  const end = parseClockToMinutes(range[2]);
  if (start === null || end === null) return null;

  return { start, end };
}

function buildHourlySlotsForDate(hoursText, reservationDate) {
  const window = parseBusinessHoursWindow(hoursText);
  if (!window) return [];

  const slots = [];
  const startHour = Math.ceil(window.start / 60);
  const endHourRaw = Math.ceil(window.end / 60);

  if (window.end > window.start) {
    for (let hour = startHour; hour < endHourRaw; hour += 1) {
      slots.push(`${String(hour % 24).padStart(2, "0")}:00`);
    }
  } else {
    for (let hour = startHour; hour < 24; hour += 1) {
      slots.push(`${String(hour).padStart(2, "0")}:00`);
    }
    for (let hour = 0; hour < endHourRaw; hour += 1) {
      slots.push(`${String(hour).padStart(2, "0")}:00`);
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  if (reservationDate === todayStr) {
    const now = new Date();
    const currentHour = now.getHours();
    return slots.filter((s) => Number(s.split(":")[0]) > currentHour);
  }

  return slots;
}

function dayColumnForDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const cols = [
    "sunday_hours",
    "monday_hours",
    "tuesday_hours",
    "wednesday_hours",
    "thursday_hours",
    "friday_hours",
    "saturday_hours",
  ];
  return cols[d.getDay()] || null;
}

let _hasReservationEventIdColumnCache = null;
async function hasReservationEventIdColumn() {
  if (_hasReservationEventIdColumnCache !== null) return _hasReservationEventIdColumnCache;
  try {
    const [rows] = await pool.query(
      `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'reservations'
         AND COLUMN_NAME = 'event_id'
       LIMIT 1`
    );
    _hasReservationEventIdColumnCache = rows.length > 0;
  } catch (_) {
    _hasReservationEventIdColumnCache = false;
  }
  return _hasReservationEventIdColumnCache;
}

function getOptionalUserId(req) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return null;
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    return Number(decoded?.id) || null;
  } catch (_) {
    return null;
  }
}

// --------------------------
// PUBLIC: Browse bars + tables + availability
// --------------------------

// GET /public/bars
router.get("/bars", async (req, res) => {
  try {
    const customerUserId = getOptionalUserId(req);
    const params = [];
    let banFilter = "";
    if (customerUserId) {
      banFilter = " WHERE NOT EXISTS (SELECT 1 FROM customer_bar_bans cbb WHERE cbb.bar_id = b.id AND cbb.customer_id = ?)";
      params.push(customerUserId);
    }

    const [rows] = await pool.query(
      `SELECT b.id, b.name, b.address, b.description, b.created_at,
              b.image_path, b.logo_path, b.video_path,
              b.logo_path AS bar_icon, b.video_path AS bar_gif,
              b.rating, b.review_count,
              (SELECT COUNT(*) FROM bar_followers bf WHERE bf.bar_id = b.id) AS follower_count
       FROM bars b
       ${banFilter}
       ORDER BY id DESC
       LIMIT 200`,
      params
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("PUBLIC BARS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /public/bars/:id
router.get("/bars/:id", async (req, res) => {
  try {
    const barId = Number(req.params.id);
    const customerUserId = getOptionalUserId(req);
    if (!barId) return res.status(400).json({ success: false, message: "Invalid bar id" });

    const params = [barId];
    let banFilter = "";
    if (customerUserId) {
      banFilter = " AND NOT EXISTS (SELECT 1 FROM customer_bar_bans cbb WHERE cbb.bar_id = b.id AND cbb.customer_id = ?)";
      params.push(customerUserId);
    }

    const [rows] = await pool.query(
      `SELECT b.id, b.name, b.address, b.description, b.created_at,
              b.image_path, b.logo_path, b.video_path,
              b.logo_path AS bar_icon, b.video_path AS bar_gif,
              b.rating, b.review_count,
              (SELECT COUNT(*) FROM bar_followers bf WHERE bf.bar_id = b.id) AS follower_count
       FROM bars b
       WHERE b.id=?${banFilter} LIMIT 1`,
      params
    );

    if (!rows.length) return res.status(404).json({ success: false, message: "Bar not found" });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("PUBLIC BAR DETAILS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /public/bars/:id/tables
router.get("/bars/:id/tables", async (req, res) => {
  try {
    const barId = Number(req.params.id);
    const customerUserId = getOptionalUserId(req);
    if (!barId) return res.status(400).json({ success: false, message: "Invalid bar id" });

    if (customerUserId) {
      const [banRows] = await pool.query(
        "SELECT 1 FROM customer_bar_bans WHERE bar_id = ? AND customer_id = ? LIMIT 1",
        [barId, customerUserId]
      );
      if (banRows.length) {
        return res.status(404).json({ success: false, message: "Bar not found" });
      }
    }

    const [rows] = await pool.query(
      `SELECT id, bar_id, table_number, capacity, is_active, created_at
       FROM bar_tables
       WHERE bar_id=?
       ORDER BY capacity ASC, table_number ASC`,
      [barId]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("PUBLIC BAR TABLES ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /public/bars/:id/available-tables?date=YYYY-MM-DD&time=HH:00&party_size=#
router.get("/bars/:id/available-tables", async (req, res) => {
  try {
    const barId = Number(req.params.id);
    const customerUserId = getOptionalUserId(req);
    if (!barId) return res.status(400).json({ success: false, message: "Invalid bar id" });

    if (customerUserId) {
      const [banRows] = await pool.query(
        "SELECT 1 FROM customer_bar_bans WHERE bar_id = ? AND customer_id = ? LIMIT 1",
        [barId, customerUserId]
      );
      if (banRows.length) {
        return res.status(404).json({ success: false, message: "Bar not found" });
      }
    }

    const { date, time, party_size } = req.query;
    if (!date || !time) {
      return res.status(400).json({ success: false, message: "date and time required" });
    }

    const dayCol = dayColumnForDate(date);
    if (!dayCol) {
      return res.status(400).json({ success: false, message: "Invalid reservation date" });
    }

    const [barHoursRows] = await pool.query(`SELECT ${dayCol} AS hours FROM bars WHERE id = ? LIMIT 1`, [barId]);
    const barHours = barHoursRows[0]?.hours || null;
    const hourlySlots = buildHourlySlotsForDate(barHours, date);
    if (!hourlySlots.length) {
      return res.json({
        success: true,
        data: [],
        message: "No available reservation slots for the selected date.",
        available_hours: [],
      });
    }

    const normalizedTime = normalizeReservationHourInput(time);
    if (!normalizedTime) {
      return res.status(400).json({ success: false, message: "Reservation time must be on the hour (HH:00)." });
    }
    const selectedHour = normalizedTime.slice(0, 5);
    if (!hourlySlots.includes(selectedHour)) {
      return res.status(400).json({
        success: false,
        message: "Selected hour is outside bar operating hours or already in the past.",
        available_hours: hourlySlots,
      });
    }

    const partySize = party_size ? Number(party_size) : null;
    if (party_size && (!Number.isFinite(partySize) || partySize <= 0)) {
      return res.status(400).json({ success: false, message: "party_size must be a positive number" });
    }

    // Available = active tables minus those already reserved (pending/approved) for same date+time
    let capacityFilter = "";
    if (partySize) capacityFilter = " AND t.capacity >= ? ";

    const baseParams = [barId];
    if (partySize) baseParams.push(partySize);
    baseParams.push(barId, date, normalizedTime);

    const [rows] = await pool.query(
      `SELECT t.id, t.bar_id, t.table_number, t.capacity, t.is_active,
              t.manual_status,
              t.image_path, t.price
       FROM bar_tables t
       WHERE t.bar_id = ?
         AND t.is_active = 1
         AND t.manual_status NOT IN ('reserved','unavailable')
         ${capacityFilter}
         AND t.id NOT IN (
           SELECT r.table_id
           FROM reservations r
           WHERE r.bar_id = ?
             AND r.reservation_date = ?
             AND r.reservation_time = ?
             AND r.status IN ('pending','approved','paid','confirmed')
         )
       ORDER BY t.capacity ASC, t.table_number ASC`,
      baseParams
    );

    return res.json({ success: true, data: rows, available_hours: hourlySlots });
  } catch (err) {
    console.error("AVAILABLE TABLES ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// --------------------------
// CUSTOMER: Create reservation + view my reservations + cancel
// --------------------------

// POST /reservations  (customer)
router.post(
  "/reservations",
  requireAuth,
  requireRole([USER_ROLES.CUSTOMER]),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const customerId = req.user.id;

      const { bar_id, table_id, event_id, reservation_date, reservation_time, party_size, notes, menu_items } = req.body || {};

      const barId = Number(bar_id);
      const tableId = Number(table_id);
      const eventId = event_id != null ? Number(event_id) : null;
      const partySize = party_size ? Number(party_size) : 1;

      if (!barId || !tableId || !reservation_date || !reservation_time) {
        return res.status(400).json({ success: false, message: "bar_id, table_id, reservation_date, reservation_time required" });
      }
      if (!Number.isFinite(partySize) || partySize <= 0) {
        return res.status(400).json({ success: false, message: "party_size must be a positive number" });
      }
      if (event_id != null && (!Number.isInteger(eventId) || eventId <= 0)) {
        return res.status(400).json({ success: false, message: "event_id must be a valid integer" });
      }

      const [banRows] = await conn.query(
        "SELECT 1 FROM customer_bar_bans WHERE bar_id = ? AND customer_id = ? LIMIT 1",
        [barId, customerId]
      );
      if (banRows.length) {
        return res.status(403).json({ success: false, message: "You are banned from this bar" });
      }

      await conn.beginTransaction();

      const includeReservationMode = await hasReservationModeColumn();
      const includeEventId = await hasReservationEventIdColumn();

      const normalizedReservationTime = normalizeReservationHourInput(reservation_time);
      if (!normalizedReservationTime) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "reservation_time must be on the hour (HH:00)." });
      }

      const dayCol = dayColumnForDate(reservation_date);
      if (!dayCol) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "Invalid reservation_date" });
      }

      const [barHoursRows] = await conn.query(`SELECT ${dayCol} AS hours FROM bars WHERE id = ? LIMIT 1`, [barId]);
      const barHours = barHoursRows[0]?.hours || null;
      const hourlySlots = buildHourlySlotsForDate(barHours, reservation_date);
      if (!hourlySlots.length) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "No available reservation slots for the selected date." });
      }
      if (!hourlySlots.includes(normalizedReservationTime.slice(0, 5))) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "Selected reservation hour is outside bar operating hours or already in the past." });
      }

      // Check reservation_mode for this bar (manual_approval default)
      const [barRows] = await conn.query(
        includeReservationMode
          ? "SELECT reservation_mode FROM bars WHERE id = ? LIMIT 1"
          : "SELECT NULL AS reservation_mode FROM bars WHERE id = ? LIMIT 1",
        [barId]
      );
      const reservationMode = String(barRows[0]?.reservation_mode || "manual_approval").toLowerCase();
      const initialStatus = reservationMode === "auto_accept" ? "approved" : "pending";

      if (eventId && includeEventId) {
        const [eventRows] = await conn.query(
          `SELECT id
           FROM bar_events
           WHERE id = ? AND bar_id = ? AND archived_at IS NULL
           LIMIT 1`,
          [eventId, barId]
        );
        if (!eventRows.length) {
          await conn.rollback();
          return res.status(404).json({ success: false, message: "Event not found for this bar" });
        }
      }

      // Check table belongs to bar and active + capacity ok
      const [tables] = await conn.query(
        `SELECT id, bar_id, capacity, is_active, manual_status
         FROM bar_tables
         WHERE id=? AND bar_id=? LIMIT 1`,
        [tableId, barId]
      );

      if (!tables.length) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: "Table not found for this bar" });
      }

      const t = tables[0];
      if (Number(t.is_active) !== 1) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "Table is inactive" });
      }
      if (String(t.manual_status || "available").toLowerCase() !== "available") {
        await conn.rollback();
        return res.status(409).json({ success: false, message: "Table is already reserved for this time" });
      }
      if (partySize > Number(t.capacity)) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: "Party size exceeds table capacity" });
      }

      // Prevent double booking – check for overlap within 1-hour window
      const [conflict] = await conn.query(
        `SELECT id, reservation_time
         FROM reservations
         WHERE bar_id = ?
           AND table_id = ?
           AND reservation_date = ?
           AND status IN ('pending','approved','paid')
           AND ABS(TIME_TO_SEC(TIMEDIFF(reservation_time, ?))) < 3600
         LIMIT 1`,
        [barId, tableId, reservation_date, normalizedReservationTime]
      );

      if (conflict.length) {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: "This table is already reserved within the same time slot. Please choose a different time (at least 1 hour apart) or another table."
        });
      }

      const txnNumber = generateTransactionNumber();

      const [ins] = includeEventId
        ? await conn.query(
            `INSERT INTO reservations
             (transaction_number, bar_id, table_id, event_id, customer_user_id, reservation_date, reservation_time, party_size, notes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [txnNumber, barId, tableId, eventId, customerId, reservation_date, normalizedReservationTime, partySize, notes || null, initialStatus]
          )
        : await conn.query(
            `INSERT INTO reservations
             (transaction_number, bar_id, table_id, customer_user_id, reservation_date, reservation_time, party_size, notes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [txnNumber, barId, tableId, customerId, reservation_date, normalizedReservationTime, partySize, notes || null, initialStatus]
          );

      // Save menu items if provided
      if (Array.isArray(menu_items) && menu_items.length > 0) {
        const validItems = menu_items.filter(
          (mi) => mi && Number(mi.menu_item_id) > 0 && Number(mi.quantity) > 0
        );
        if (validItems.length > 0) {
          const itemRows = validItems.map((mi) => [
            ins.insertId,
            barId,
            Number(mi.menu_item_id),
            Number(mi.quantity),
            Number(mi.unit_price || 0),
          ]);
          await conn.query(
            `INSERT INTO reservation_items (reservation_id, bar_id, menu_item_id, quantity, unit_price) VALUES ?`,
            [itemRows]
          );
        }
      }

      await conn.commit();

      logAudit(null, {
        bar_id: barId,
        user_id: customerId,
        action: "CREATE_RESERVATION",
        entity: "reservations",
        entity_id: ins.insertId,
        details: {
          table_id: tableId,
          event_id: includeEventId ? eventId : null,
          reservation_date,
          reservation_time: normalizedReservationTime,
          status: initialStatus,
        },
        ...auditContext(req),
      });

      return res.status(201).json({
        success: true,
        message: initialStatus === "approved" ? "Reservation auto-approved" : "Reservation created",
        data: { id: ins.insertId, transaction_number: txnNumber }
      });
    } catch (err) {
      await conn.rollback();
      console.error("CREATE RESERVATION ERROR:", err);
      return res.status(500).json({ success: false, message: err.sqlMessage || err.message || "Server error" });
    } finally {
      conn.release();
    }
  }
);

// GET /reservations/my (customer)
router.get(
  "/reservations/my",
  requireAuth,
  requireRole([USER_ROLES.CUSTOMER]),
  async (req, res) => {
    try {
      const customerId = req.user.id;

      const [rows] = await pool.query(
        `SELECT r.id, r.transaction_number, r.bar_id, b.name AS bar_name, r.table_id, t.table_number,
                r.reservation_date, r.reservation_time, r.party_size,
                r.status, r.payment_status, r.notes, r.paid_at, r.created_at,
                pt.reference_id, pt.payment_method
         FROM reservations r
         JOIN bars b ON b.id = r.bar_id
         JOIN bar_tables t ON t.id = r.table_id
         LEFT JOIN payment_transactions pt ON pt.id = (
           SELECT id FROM payment_transactions
           WHERE payment_type = 'reservation' AND related_id = r.id
           ORDER BY created_at DESC LIMIT 1
         )
         WHERE r.customer_user_id=?
         ORDER BY r.created_at DESC
         LIMIT 200`,
        [customerId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("MY RESERVATIONS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// GET /reservations/lookup/:txn — Bar owner looks up reservation by transaction number
router.get(
  "/reservations/lookup/:txn",
  requireAuth,
  requirePermission(["reservation_view"]),
  async (req, res) => {
    try {
      const txn = String(req.params.txn || '').trim().toUpperCase();
      if (!txn) return res.status(400).json({ success: false, message: "Transaction number required" });

      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar associated with your account" });

      const [rows] = await pool.query(
        `SELECT r.id, r.transaction_number, r.bar_id, b.name AS bar_name,
                r.table_id, t.table_number, t.capacity, t.price AS table_price,
                r.customer_user_id, u.first_name, u.last_name, u.email, u.phone_number,
                r.reservation_date, r.reservation_time, r.party_size, r.occasion, r.notes,
                r.status, r.payment_status, r.deposit_amount, r.created_at
         FROM reservations r
         JOIN bars b ON b.id = r.bar_id
         JOIN bar_tables t ON t.id = r.table_id
         LEFT JOIN users u ON u.id = r.customer_user_id
         WHERE r.transaction_number = ?
           AND r.bar_id = ?
         LIMIT 1`,
        [txn, barId]
      );

      if (!rows.length) {
        return res.status(404).json({ success: false, message: "Reservation not found or does not belong to your bar" });
      }

      const reservation = rows[0];

      // Fetch reservation items if table exists
      const [riCheck] = await pool.query(
        `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reservation_items' LIMIT 1`
      );

      let items = [];
      if (riCheck.length) {
        const [itemRows] = await pool.query(
          `SELECT ri.menu_item_id, m.menu_name, ri.quantity, ri.unit_price,
                  (ri.quantity * ri.unit_price) AS line_total
           FROM reservation_items ri
           JOIN menu_items m ON m.id = ri.menu_item_id
           WHERE ri.reservation_id = ?
           ORDER BY m.menu_name`,
          [reservation.id]
        );
        items = itemRows;
      }

      // Fetch payment transaction info
      const [paymentRows] = await pool.query(
        `SELECT pt.id AS payment_id, pt.reference_id, pt.amount, pt.status AS payment_status,
                pt.payment_method, pt.paid_at, pt.created_at AS payment_created_at
         FROM payment_transactions pt
         WHERE pt.payment_type = 'reservation' AND pt.related_id = ?
         ORDER BY pt.created_at DESC LIMIT 1`,
        [reservation.id]
      );
      const payment = paymentRows[0] || null;

      const totalAmount = items.reduce((sum, it) => sum + Number(it.line_total || 0), 0)
        + Number(reservation.table_price || 0);

      return res.json({
        success: true,
        data: {
          ...reservation,
          items,
          total_amount: totalAmount || Number(payment?.amount || 0),
          payment: payment ? {
            payment_id: payment.payment_id,
            reference_id: payment.reference_id,
            amount: Number(payment.amount),
            status: payment.payment_status,
            payment_method: payment.payment_method,
            paid_at: payment.paid_at,
          } : null,
        },
      });
    } catch (err) {
      console.error("LOOKUP RESERVATION ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// POST /reservations/:id/recheck-payment (customer) - Fix payment status mismatch
router.post(
  "/reservations/:id/recheck-payment",
  requireAuth,
  requireRole([USER_ROLES.CUSTOMER]),
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

      const [rows] = await pool.query(
        `SELECT id, status, payment_status FROM reservations WHERE id=? AND customer_user_id=? LIMIT 1`,
        [id, customerId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: "Reservation not found" });

      // Get latest payment transaction
      const [payments] = await pool.query(
        `SELECT status, paid_at FROM payment_transactions
         WHERE payment_type = 'reservation' AND related_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        [id]
      );

      if (!payments.length) {
        return res.status(400).json({ success: false, message: "No payment found for this reservation" });
      }

      const latestPayment = payments[0];
      
      // If payment is paid but reservation is cancelled, fix it
      if (latestPayment.status === 'paid' && rows[0].status === 'cancelled') {
        await pool.query(
          `UPDATE reservations SET status = 'confirmed', payment_status = 'paid', paid_at = ? WHERE id = ?`,
          [latestPayment.paid_at, id]
        );
        return res.json({ success: true, message: "Reservation status corrected to confirmed", data: { status: 'confirmed', payment_status: 'paid' } });
      }

      // If payment is cancelled/failed but reservation is confirmed, fix it
      if (['cancelled', 'failed'].includes(latestPayment.status) && rows[0].status === 'confirmed') {
        await pool.query(
          `UPDATE reservations SET status = 'cancelled', payment_status = 'cancelled' WHERE id = ?`,
          [id]
        );
        return res.json({ success: true, message: "Reservation status corrected to cancelled", data: { status: 'cancelled', payment_status: 'cancelled' } });
      }

      return res.json({ success: true, message: "Status already correct", data: { status: rows[0].status, payment_status: rows[0].payment_status } });
    } catch (err) {
      console.error("RECHECK PAYMENT ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// PATCH /reservations/:id/cancel (customer)
router.patch(
  "/reservations/:id/cancel",
  requireAuth,
  requireRole([USER_ROLES.CUSTOMER]),
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

      const [rows] = await pool.query(
        `SELECT id, status
         FROM reservations
         WHERE id=? AND customer_user_id=? LIMIT 1`,
        [id, customerId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: "Reservation not found" });

      if (rows[0].status === "cancelled") {
        return res.status(400).json({ success: false, message: "Already cancelled" });
      }

      await pool.query(
        `UPDATE reservations
         SET status='cancelled'
         WHERE id=? AND customer_user_id=?`,
        [id, customerId]
      );

      return res.json({ success: true, message: "Reservation cancelled" });
    } catch (err) {
      console.error("CANCEL RESERVATION ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// --------------------------
// OWNER: Manage reservations (approve/reject/cancel)
// --------------------------

// GET /owner/reservations?status=pending&date=YYYY-MM-DD
router.get(
  "/owner/reservations",
  requireAuth,
  requirePermission("reservation_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const { status, date } = req.query;

      const where = ["r.bar_id = ?"];
      const params = [barId];

      if (status) {
        where.push("r.status = ?");
        params.push(status);
      }
      if (date) {
        where.push("r.reservation_date = ?");
        params.push(date);
      }

      const [rows] = await pool.query(
        `SELECT r.id, r.transaction_number, r.table_id, t.table_number, r.customer_user_id,
                COALESCE(NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), ''), 'Guest') AS guest_name,
                cu.email AS guest_email,
                cu.phone_number AS guest_phone,
                r.reservation_date, r.reservation_time, r.party_size,
                r.status, r.payment_status, r.deposit_amount,
                r.occasion, r.notes, r.created_at
         FROM reservations r
         JOIN bar_tables t ON t.id = r.table_id
         LEFT JOIN users cu ON cu.id = r.customer_user_id
         WHERE ${where.join(" AND ")}
         ORDER BY r.reservation_date DESC, r.reservation_time DESC
         LIMIT 300`,
        params
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("OWNER RESERVATIONS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// PATCH /owner/reservations/:id/status  body: { action: "approve"|"reject"|"cancel" }
router.patch(
  "/owner/reservations/:id/status",
  requireAuth,
  requirePermission("reservation_manage"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

      const action = String(req.body?.action || "").toLowerCase();
      const allowed = ["approve", "reject", "cancel"];
      if (!allowed.includes(action)) {
        return res.status(400).json({ success: false, message: "action must be approve, reject, or cancel" });
      }

      const nextStatus =
        action === "approve" ? "approved" :
        action === "reject" ? "rejected" :
        "cancelled";

      const [found] = await pool.query(
        `SELECT id, status, payment_status
         FROM reservations
         WHERE id=? AND bar_id=? LIMIT 1`,
        [id, barId]
      );
      if (!found.length) return res.status(404).json({ success: false, message: "Reservation not found" });

      const current = found[0];
      if ((action === 'cancel' || action === 'reject') && current.payment_status === 'paid') {
        return res.status(400).json({ success: false, message: "Cannot cancel or reject a paid reservation. Process a refund first." });
      }
      if (current.status === 'cancelled') {
        return res.status(400).json({ success: false, message: "Reservation is already cancelled." });
      }

      await pool.query(
        `UPDATE reservations
         SET status=?
         WHERE id=? AND bar_id=?`,
        [nextStatus, id, barId]
      );

      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action:
          nextStatus === "approved"
            ? "APPROVE_RESERVATION"
            : nextStatus === "rejected"
            ? "REJECT_RESERVATION"
            : "CANCEL_RESERVATION",
        entity: "reservations",
        entity_id: id,
        details: { reservation_id: id, new_status: nextStatus },
        ...auditContext(req),
      });

      return res.json({ success: true, message: `Reservation ${nextStatus}` });
    } catch (err) {
      console.error("OWNER UPDATE RESERVATION ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// --------------------------
// PUBLIC: Guest reservation request (no auth required)
// --------------------------
router.post("/reservations/guest", async (req, res) => {
  try {
    const { full_name, phone, email, venue, date, time, guests, occasion, notes } = req.body || {};

    if (!full_name || !email || !venue || !date || !time) {
      return res.status(400).json({ success: false, message: "Full name, email, venue, date, and time are required" });
    }

    const partySize = guests ? Number(guests) : 1;

    const includeReservationMode = await hasReservationModeColumn();

    // Resolve bar by name
    const [bars] = await pool.query(
      includeReservationMode
        ? "SELECT id, reservation_mode FROM bars WHERE name = ? AND status = 'active' LIMIT 1"
        : "SELECT id, NULL AS reservation_mode FROM bars WHERE name = ? AND status = 'active' LIMIT 1",
      [venue]
    );
    const barId = bars.length ? bars[0].id : null;
    const reservationMode = String(bars[0]?.reservation_mode || "manual_approval").toLowerCase();
    const initialStatus = reservationMode === "auto_accept" ? "approved" : "pending";

    const [result] = await pool.query(
      `INSERT INTO reservations
       (bar_id, guest_name, guest_email, guest_phone, reservation_date, reservation_time, party_size, occasion, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [barId, full_name, email, phone || null, date, time, partySize, occasion || null, notes || null, initialStatus]
    );

    return res.status(201).json({
      success: true,
      message: initialStatus === "approved"
        ? "Reservation submitted and auto-approved."
        : "Reservation request submitted successfully. We'll confirm shortly.",
      data: { id: result.insertId },
    });
  } catch (err) {
    console.error("GUEST RESERVATION ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
