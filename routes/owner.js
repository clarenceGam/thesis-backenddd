const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const bcrypt = require("bcrypt");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const requireAuth = require("../middlewares/requireAuth");
const requireRole = require("../middlewares/requireRole");
const requirePermission = require("../middlewares/requirePermission");
const { USER_ROLES, OWNER_ALLOWED_CREATE } = require("../config/constants");
const { logAudit, auditContext } = require("../utils/audit");

function toPermissionDisplayName(code) {
  return String(code || "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toPermissionFriendlyDescription(code) {
  const key = String(code || "").toLowerCase();

  const exact = {
    // Bar
    bar_details_view: "View bar profile and settings.",
    bar_details_update: "Edit bar profile, hours, and settings.",
    // Staff
    staff_view: "View staff accounts and records.",
    staff_create: "Create new staff accounts.",
    staff_update: "Edit staff profiles and details.",
    staff_delete: "Permanently delete staff accounts.",
    staff_deactivate: "Activate or deactivate staff accounts.",
    staff_reset_password: "Reset a staff member's password.",
    staff_edit_permissions: "Edit staff roles and permissions.",
    // Attendance
    attendance_view_own: "View own attendance records.",
    attendance_view_all: "View all attendance records.",
    attendance_create: "Create attendance entries.",
    // Leave
    leave_apply: "Submit leave requests.",
    leave_view_own: "View own leave requests.",
    leave_view_all: "View all leave requests.",
    leave_approve: "Approve or reject leave requests.",
    // Payroll
    payroll_view_own: "View own payroll records.",
    payroll_view_all: "View all payroll records.",
    payroll_create: "Run payroll processing.",
    // Documents
    documents_view_own: "View own documents.",
    documents_view_all: "View all documents.",
    documents_send: "Upload and send documents.",
    documents_manage: "Approve and manage documents.",
    // Menu / Inventory
    menu_view: "View menu items and inventory.",
    menu_create: "Create menu items.",
    menu_update: "Edit menu items and inventory.",
    menu_delete: "Delete menu items.",
    // Reservation
    reservation_view: "View reservations.",
    reservation_manage: "Manage reservation status.",
    reservation_create: "Create reservations.",
    // Events
    events_view: "View bar events and posts.",
    events_create: "Create bar events.",
    events_update: "Edit bar events.",
    events_delete: "Delete bar events and posts.",
    events_comment_manage: "Moderate event and post comments.",
    events_comment_reply: "Reply to event comments.",
    // Tables
    table_view: "View table layout.",
    table_update: "Manage table layout and status.",
    // Financials
    financials_view: "View financial reports and cashflow.",
    // Analytics / DSS
    analytics_bar_view: "View analytics and DSS insights.",
    // Reviews
    reviews_view: "View customer reviews.",
    reviews_reply: "Reply to customer reviews.",
    // Bans
    ban_view: "View customer ban list.",
    ban_branch: "Ban customers from this bar.",
    ban_lift: "Lift customer bans.",
    // Logs
    logs_view: "View audit logs and activity history.",
  };

  if (exact[key]) return exact[key];

  const display = toPermissionDisplayName(code).toLowerCase();
  return `Allows ${display}.`;
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

let _hasReservationTimeLimitColumnsCache = null;
async function hasReservationTimeLimitColumns() {
  if (_hasReservationTimeLimitColumnsCache !== null) return _hasReservationTimeLimitColumnsCache;
  try {
    const [rows] = await pool.query(
      `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'bars'
         AND COLUMN_NAME = 'reservation_time_limit_mode'
       LIMIT 1`
    );
    _hasReservationTimeLimitColumnsCache = rows.length > 0;
  } catch (_) {
    _hasReservationTimeLimitColumnsCache = false;
  }
  return _hasReservationTimeLimitColumnsCache;
}

let _hasBarTypesColumnCache = null;
async function hasBarTypesColumn() {
  if (_hasBarTypesColumnCache !== null) return _hasBarTypesColumnCache;
  try {
    const [rows] = await pool.query(
      `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'bars'
         AND COLUMN_NAME = 'bar_types'
       LIMIT 1`
    );
    _hasBarTypesColumnCache = rows.length > 0;
  } catch (_) {
    _hasBarTypesColumnCache = false;
  }
  return _hasBarTypesColumnCache;
}

let _hasBarStaffTypesColumnCache = null;
async function hasBarStaffTypesColumn() {
  if (_hasBarStaffTypesColumnCache !== null) return _hasBarStaffTypesColumnCache;
  try {
    const [rows] = await pool.query(
      `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'bars'
         AND COLUMN_NAME = 'staff_types'
       LIMIT 1`
    );
    _hasBarStaffTypesColumnCache = rows.length > 0;
  } catch (_) {
    _hasBarStaffTypesColumnCache = false;
  }
  return _hasBarStaffTypesColumnCache;
}

let _hasUserStaffTypeColumnCache = null;
async function hasUserStaffTypeColumn() {
  if (_hasUserStaffTypeColumnCache !== null) return _hasUserStaffTypeColumnCache;
  try {
    const [rows] = await pool.query(
      `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME = 'staff_type'
       LIMIT 1`
    );
    _hasUserStaffTypeColumnCache = rows.length > 0;
  } catch (_) {
    _hasUserStaffTypeColumnCache = false;
  }
  return _hasUserStaffTypeColumnCache;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return normalizeStringArray(value);
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return normalizeStringArray(parsed);
  } catch (_) {
    return [];
  }
}

async function getBarStaffTypes(barId) {
  if (!(await hasBarStaffTypesColumn())) return [];
  const [[barRow]] = await pool.query(
    `SELECT staff_types
     FROM bars
     WHERE id = ?
     LIMIT 1`,
    [barId]
  );
  return parseJsonArray(barRow?.staff_types);
}

function normalizeStaffTypeValue(staffType, allowedStaffTypes) {
  const normalized = String(staffType || "").trim();
  if (!normalized) return null;
  const matched = (allowedStaffTypes || []).find(
    (type) => String(type || "").trim().toLowerCase() === normalized.toLowerCase()
  );
  return matched || null;
}

// â”€â”€â”€ Multer storage for bar profile images â”€â”€â”€
const barImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/bars";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `bar_${req.user.bar_id}_${Date.now()}${ext}`);
  }
});

// â”€â”€â”€ Multer storage for bar icon and GIF media â”€â”€â”€
const barIconUpload = multer({
  storage: barImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (!allowed.test(path.extname(file.originalname))) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  }
});

const barGifStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/bars";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `bar_gif_${req.user.bar_id}_${Date.now()}${ext}`);
  }
});

const barGifUpload = multer({
  storage: barGifStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(gif|mp4|webm)$/i;
    if (!allowed.test(path.extname(file.originalname))) {
      return cb(new Error("Only GIF/MP4/WEBM files are allowed"));
    }
    cb(null, true);
  }
});
const barImageUpload = multer({
  storage: barImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (!allowed.test(path.extname(file.originalname))) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  }
});

// â”€â”€â”€ Multer storage for event images â”€â”€â”€
const eventImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/events";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `event_${req.user.bar_id}_${Date.now()}${ext}`);
  }
});
const eventImageUpload = multer({
  storage: eventImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (!allowed.test(path.extname(file.originalname))) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  }
});

// â”€â”€â”€ Multer storage for table images â”€â”€â”€
const tableImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/tables";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `table_${req.user.bar_id}_${Date.now()}${ext}`);
  }
});
const tableImageUpload = multer({
  storage: tableImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (!allowed.test(path.extname(file.originalname))) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  }
});

// Create user for bar owner (admin/staff) - DEPRECATED - use /owner/users instead
router.post("/create-user", requireAuth, requireRole([USER_ROLES.BAR_OWNER]), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Define allowed roles for bar owner users
    const allowedRoles = OWNER_ALLOWED_CREATE;
    
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Allowed roles: ${allowedRoles.join(", ")}`,
      });
    }

    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Get bar owner ID for the current user
    const [barOwnerRows] = await pool.query(
      "SELECT id FROM bar_owners WHERE user_id = ? LIMIT 1",
      [req.user.id]
    );
    
    if (!barOwnerRows.length) {
      return res.status(400).json({
        success: false,
        message: "Bar owner profile not found",
      });
    }
    
    const barOwnerId = barOwnerRows[0].id;

    // Check if email already exists for this bar owner
    const [existingUser] = await pool.query(
      "SELECT id FROM bar_owner_users WHERE bar_owner_id = ? AND email = ? LIMIT 1",
      [barOwnerId, email]
    );
    
    if (existingUser.length) {
      return res.status(409).json({
        success: false,
        message: "Email already exists for this bar",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new bar owner user
    const [result] = await pool.query(
      `INSERT INTO bar_owner_users (
        bar_owner_id, name, email, password, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
      [barOwnerId, name, email, hashedPassword, role]
    );

    return res.json({
      success: true,
      message: "User created successfully",
      data: { id: result.insertId },
    });
  } catch (err) {
    console.error("OWNER CREATE USER ERROR:", err.message);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

router.post(
  "/bar/users",
  requireAuth,
  requirePermission("staff_create"),
  async (req, res) => {
    try {
      const { first_name, last_name, email, password, phone_number, role, staff_type } = req.body;

      // Validate roles using constants
      if (!OWNER_ALLOWED_CREATE.includes(role)) {
        return res.status(400).json({ 
          success: false, 
          message: `Invalid role. Allowed roles: ${OWNER_ALLOWED_CREATE.join(", ")}` 
        });
      }

      // Validate required fields
      if (!first_name || !last_name || !email || !password) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
      }

      // Use bar_id from authenticated user
      const barId = req.user.bar_id;
      if (!barId) {
        return res.status(400).json({ success: false, message: "No bar_id on account" });
      }

      const hasStaffTypeCol = await hasUserStaffTypeColumn();
      const allowedStaffTypes = hasStaffTypeCol ? await getBarStaffTypes(barId) : [];
      const normalizedStaffType = hasStaffTypeCol ? normalizeStaffTypeValue(staff_type, allowedStaffTypes) : null;
      if (hasStaffTypeCol && String(staff_type || "").trim() && !normalizedStaffType) {
        return res.status(400).json({ success: false, message: "Invalid staff type selected for this bar" });
      }

      // unique email
      const [existing] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (existing.length) {
        return res.status(409).json({ success: false, message: "Email already exists" });
      }

      const hashed = await bcrypt.hash(password, 10);

      // Auto-resolve role_id from roles table for RBAC permission system
      const roleUpper = String(role).toUpperCase();
      const [roleRows] = await pool.query(
        "SELECT id FROM roles WHERE UPPER(name) = ? LIMIT 1",
        [roleUpper]
      );
      const roleId = roleRows.length ? roleRows[0].id : null;

      const insertColumns = ["first_name", "last_name", "email", "password", "phone_number", "role"];
      const insertValues = [first_name, last_name, email, hashed, phone_number || null, role];

      if (hasStaffTypeCol) {
        insertColumns.push("staff_type");
        insertValues.push(normalizedStaffType);
      }

      insertColumns.push("role_id", "is_active", "bar_id");
      insertValues.push(roleId, 1, barId);

      const [result] = await pool.query(
        `INSERT INTO users
          (${insertColumns.join(", ")}, created_at, updated_at)
         VALUES (${insertColumns.map(() => "?").join(", ")}, NOW(), NOW())`,
        insertValues
      );

      // Seed user_permissions from role_permissions so new staff accounts are never blank.
      if (roleId) {
        await pool.query(
          `INSERT INTO user_permissions (user_id, permission_id, granted_by)
           SELECT ?, rp.permission_id, ?
           FROM role_permissions rp
           WHERE rp.role_id = ?`,
          [result.insertId, req.user.id, roleId]
        );
      }

      return res.status(201).json({
        success: true,
        message: "Staff/HR created",
        data: { user_id: result.insertId, bar_id: barId }
      });
    } catch (err) {
      console.error("BAR CREATE USER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: Reply to event comment â”€â”€â”€
router.post(
  "/bar/comments/events/:id/replies",
  requireAuth,
  requirePermission("events_comment_reply"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const commentId = Number(req.params.id);
      const reply = String(req.body?.reply || "").trim();

      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!commentId) return res.status(400).json({ success: false, message: "Invalid comment id" });
      if (!reply) return res.status(400).json({ success: false, message: "reply is required" });

      const [commentRows] = await pool.query(
        `SELECT ec.id, ec.event_id
         FROM event_comments ec
         JOIN bar_events be ON be.id = ec.event_id
         WHERE ec.id = ? AND be.bar_id = ? AND ec.status = 'active'
         LIMIT 1`,
        [commentId, barId]
      );

      if (!commentRows.length) {
        return res.status(404).json({ success: false, message: "Comment not found" });
      }

      const eventId = Number(commentRows[0].event_id);

      const [ins] = await pool.query(
        `INSERT INTO event_comment_replies (event_comment_id, event_id, user_id, reply)
         VALUES (?, ?, ?, ?)`,
        [commentId, eventId, req.user.id, reply]
      );

      const [createdRows] = await pool.query(
        `SELECT r.id, r.event_comment_id, r.event_id, r.user_id, r.reply, r.status, r.created_at, r.updated_at,
                u.first_name, u.last_name, u.profile_picture
         FROM event_comment_replies r
         JOIN users u ON u.id = r.user_id
         WHERE r.id = ?
         LIMIT 1`,
        [ins.insertId]
      );

      return res.status(201).json({
        success: true,
        message: "Reply posted",
        data: createdRows[0] || null,
      });
    } catch (err) {
      console.error("OWNER REPLY EVENT COMMENT ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.patch(
  "/bar/users/:id",
  requireAuth,
  requirePermission("staff_update"),
  async (req, res) => {
    try {
      const { first_name, last_name, email, phone_number, role, is_active, staff_type } = req.body;
      const userId = Number(req.params.id);
      let nextRoleId = null;
      
      if (!userId) {
        return res.status(400).json({ success: false, message: "Invalid user ID" });
      }

      const barId = req.user.bar_id;
      if (!barId) {
        return res.status(400).json({ success: false, message: "No bar_id on account" });
      }

      const hasStaffTypeCol = await hasUserStaffTypeColumn();
      const allowedStaffTypes = hasStaffTypeCol ? await getBarStaffTypes(barId) : [];

      // Check if user exists and belongs to same bar
      const [userRows] = await pool.query(
        "SELECT id FROM users WHERE id = ? AND bar_id = ? LIMIT 1",
        [userId, barId]
      );
      
      if (!userRows.length) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      // Build dynamic update query
      const updates = [];
      const params = [];

      if (first_name !== undefined) {
        updates.push("first_name = ?");
        params.push(first_name);
      }
      if (last_name !== undefined) {
        updates.push("last_name = ?");
        params.push(last_name);
      }
      if (email !== undefined) {
        updates.push("email = ?");
        params.push(email);
      }
      if (phone_number !== undefined) {
        updates.push("phone_number = ?");
        params.push(phone_number);
      }
      if (hasStaffTypeCol && staff_type !== undefined) {
        const normalizedStaffType = String(staff_type || "").trim()
          ? normalizeStaffTypeValue(staff_type, allowedStaffTypes)
          : null;
        if (String(staff_type || "").trim() && !normalizedStaffType) {
          return res.status(400).json({ success: false, message: "Invalid staff type selected for this bar" });
        }
        updates.push("staff_type = ?");
        params.push(normalizedStaffType);
      }
      if (role !== undefined) {
        if (!OWNER_ALLOWED_CREATE.includes(role)) {
          return res.status(400).json({ 
            success: false, 
            message: `Invalid role. Allowed roles: ${OWNER_ALLOWED_CREATE.join(", ")}` 
          });
        }
        // Resolve role_id from roles table
        const roleUpper = String(role).toUpperCase();
        const [roleRows] = await pool.query(
          "SELECT id FROM roles WHERE UPPER(name) = ? LIMIT 1",
          [roleUpper]
        );
        updates.push("role = ?");
        params.push(role);
        if (roleRows.length) {
          nextRoleId = roleRows[0].id;
          updates.push("role_id = ?");
          params.push(roleRows[0].id);
        }
      }
      if (is_active !== undefined) {
        updates.push("is_active = ?");
        params.push(is_active ? 1 : 0);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: "No fields to update" });
      }

      updates.push("updated_at = NOW()");
      params.push(userId, barId);

      const [result] = await pool.query(
        `UPDATE users SET ${updates.join(", ")} WHERE id = ? AND bar_id = ?`,
        params
      );

      // When role changes, sync user_permissions with role defaults.
      if (nextRoleId) {
        await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [userId]);
        await pool.query(
          `INSERT INTO user_permissions (user_id, permission_id, granted_by)
           SELECT ?, rp.permission_id, ?
           FROM role_permissions rp
           WHERE rp.role_id = ?`,
          [userId, req.user.id, nextRoleId]
        );
      }

      return res.json({ success: true, message: "User updated successfully" });
    } catch (err) {
      console.error("BAR UPDATE USER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);


// â”€â”€â”€ PATCH BAR SETTINGS â”€â”€â”€
router.patch(
  "/bar/settings",
  requireAuth,
  requirePermission("bar_details_update"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const { name, address, phone, email, operating_hours, settings } = req.body || {};

      // Build dynamic update query for bars table
      const updates = [];
      const params = [];

      if (name !== undefined) {
        updates.push("name = ?");
        params.push(name);
      }
      if (address !== undefined) {
        updates.push("address = ?");
        params.push(address);
      }
      if (phone !== undefined) {
        updates.push("phone = ?");
        params.push(phone);
      }
      if (email !== undefined) {
        updates.push("email = ?");
        params.push(email);
      }
      if (operating_hours !== undefined) {
        updates.push("operating_hours = ?");
        params.push(operating_hours);
      }
      if (settings !== undefined) {
        updates.push("settings = ?");
        params.push(JSON.stringify(settings));
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: "No fields to update" });
      }

      updates.push("updated_at = NOW()");
      params.push(barId);

      const [result] = await pool.query(
        `UPDATE bars SET ${updates.join(", ")} WHERE id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "Bar not found" });
      }

      // Audit log the bar details update
      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action: "UPDATE_BAR_DETAILS",
        entity: "bars",
        entity_id: barId,
        details: { fields_updated: Object.keys(req.body).filter(k => req.body[k] !== undefined) },
        ...auditContext(req)
      });

      return res.json({ success: true, message: "Bar settings updated successfully" });
    } catch (err) {
      console.error("BAR SETTINGS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ GET BAR DETAILS (Owner can view their own bar) â”€â”€â”€
router.get(
  "/bar/details",
  requireAuth,
  requirePermission("bar_details_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const includeReservationMode = await hasReservationModeColumn();
      const includeBarTypes = await hasBarTypesColumn();
      const includeStaffTypes = await hasBarStaffTypesColumn();
      let includeTimeLimits = false;
      try {
        includeTimeLimits = await hasReservationTimeLimitColumns();
      } catch (err) {
        console.warn("Error checking time limit columns:", err);
      }
      const reservationModeSelect = includeReservationMode
        ? ", reservation_mode"
        : ", 'manual_approval' AS reservation_mode";
      const staffTypesSelect = includeStaffTypes ? ", staff_types" : ", NULL AS staff_types";
      const barTypesSelect = includeBarTypes ? ", bar_types" : ", NULL AS bar_types";
      const timeLimitSelect = includeTimeLimits
        ? ` ${barTypesSelect}, reservation_time_limit_mode, reservation_time_limit_minutes`
        : `${barTypesSelect}, NULL AS reservation_time_limit_mode, NULL AS reservation_time_limit_minutes`;

      const [rows] = await pool.query(
        `SELECT id, name, description, address, city, state, zip_code,
                phone, contact_number, email, website, category, price_range,
                image_path, logo_path, video_path,
                logo_path AS bar_icon, video_path AS bar_gif,
                (SELECT COUNT(*) FROM bar_followers bf WHERE bf.bar_id = bars.id) AS follower_count,
                latitude, longitude,
                monday_hours, tuesday_hours, wednesday_hours, thursday_hours,
                friday_hours, saturday_hours, sunday_hours,
                accept_cash_payment, accept_online_payment, accept_gcash,
                gcash_number, gcash_account_name,
                minimum_reservation_deposit${staffTypesSelect}${reservationModeSelect}${timeLimitSelect},
                status, rating, review_count, created_at, updated_at
         FROM bars
         WHERE id = ? LIMIT 1`,
        [barId]
      );

      if (!rows.length) return res.status(404).json({ success: false, message: "Bar not found" });

      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("GET BAR DETAILS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ PATCH BAR DETAILS (comprehensive â€” all bar columns) â”€â”€â”€
router.patch(
  "/bar/details",
  requireAuth,
  requirePermission("bar_details_update"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const includeReservationMode = await hasReservationModeColumn();
      const includeBarTypes = await hasBarTypesColumn();
      const includeStaffTypes = await hasBarStaffTypesColumn();
      let includeTimeLimits = false;
      try {
        includeTimeLimits = await hasReservationTimeLimitColumns();
      } catch (err) {
        console.warn("Error checking time limit columns:", err);
      }

      const allowed = [
        "name", "description", "address", "city", "state", "zip_code",
        "phone", "contact_number", "email", "website", "category", "price_range",
        "logo_path", "video_path",
        "latitude", "longitude",
        "monday_hours", "tuesday_hours", "wednesday_hours", "thursday_hours",
        "friday_hours", "saturday_hours", "sunday_hours",
        "accept_cash_payment", "accept_online_payment", "accept_gcash",
        "minimum_reservation_deposit",
        "gcash_number", "gcash_account_name"
      ];
      if (includeStaffTypes) allowed.push("staff_types");
      if (includeBarTypes) allowed.push("bar_types");
      if (includeReservationMode) allowed.push("reservation_mode");
      if (includeTimeLimits) allowed.push("reservation_time_limit_mode", "reservation_time_limit_minutes");

      const updates = [];
      const params = [];

      if (req.body.bar_icon !== undefined) {
        req.body.logo_path = req.body.bar_icon;
      }
      if (req.body.bar_gif !== undefined) {
        req.body.video_path = req.body.bar_gif;
      }

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates.push(`${key} = ?`);
          if (key === "staff_types" || key === "bar_types") {
            params.push(JSON.stringify(parseJsonArray(req.body[key])));
          } else {
            params.push(req.body[key]);
          }
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: "No fields to update" });
      }

      updates.push("updated_at = NOW()");
      params.push(barId);

      const [result] = await pool.query(
        `UPDATE bars SET ${updates.join(", ")} WHERE id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "Bar not found" });
      }

      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action: "UPDATE_BAR_DETAILS",
        entity: "bars",
        entity_id: barId,
        details: { fields_updated: Object.keys(req.body).filter(k => allowed.includes(k) && req.body[k] !== undefined) },
        ...auditContext(req)
      });

      // Return updated bar
      const reservationModeSelect = includeReservationMode
        ? ", reservation_mode"
        : ", 'manual_approval' AS reservation_mode";
      const updatedStaffTypesSelect = includeStaffTypes ? ", staff_types" : ", NULL AS staff_types";
      const updatedBarTypesSelect = includeBarTypes ? ", bar_types" : ", NULL AS bar_types";
      const updatedTimeLimitSelect = includeTimeLimits
        ? `${updatedBarTypesSelect}, reservation_time_limit_mode, reservation_time_limit_minutes`
        : `${updatedBarTypesSelect}, NULL AS reservation_time_limit_mode, NULL AS reservation_time_limit_minutes`;
      const [updated] = await pool.query(
        `SELECT id, name, description, address, city, state, zip_code,
                phone, contact_number, email, website, category, price_range,
                image_path, logo_path, video_path,
                logo_path AS bar_icon, video_path AS bar_gif,
                (SELECT COUNT(*) FROM bar_followers bf WHERE bf.bar_id = bars.id) AS follower_count,
                latitude, longitude,
                monday_hours, tuesday_hours, wednesday_hours, thursday_hours,
                friday_hours, saturday_hours, sunday_hours,
                accept_cash_payment, accept_online_payment, accept_gcash,
                gcash_number, gcash_account_name,
                minimum_reservation_deposit${updatedStaffTypesSelect}${reservationModeSelect}${updatedTimeLimitSelect},
                status, updated_at
         FROM bars WHERE id = ? LIMIT 1`,
        [barId]
      );

      return res.json({ success: true, message: "Bar details updated", data: updated[0] || null });
    } catch (err) {
      console.error("UPDATE BAR DETAILS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ POST BAR IMAGE (file upload for bar profile image) â”€â”€â”€
router.post(
  "/bar/image",
  requireAuth,
  requirePermission("bar_details_update"),
  barImageUpload.single("image"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

      const filePath = req.file.path.replace(/\\/g, "/");

      const [result] = await pool.query(
        "UPDATE bars SET image_path = ?, updated_at = NOW() WHERE id = ?",
        [filePath, barId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "Bar not found" });
      }

      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action: "UPDATE_BAR_IMAGE",
        entity: "bars",
        entity_id: barId,
        details: { image_path: filePath },
        ...auditContext(req)
      });

      return res.json({ success: true, message: "Bar image uploaded", data: { image_path: filePath } });
    } catch (err) {
      console.error("BAR IMAGE UPLOAD ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ POST BAR ICON (file upload for bar icon) â”€â”€â”€
router.post(
  "/bar/icon",
  requireAuth,
  requirePermission("bar_details_update"),
  barIconUpload.single("bar_icon"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

      const filePath = req.file.path.replace(/\\/g, "/");
      const [result] = await pool.query(
        "UPDATE bars SET logo_path = ?, updated_at = NOW() WHERE id = ?",
        [filePath, barId]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "Bar not found" });
      }

      return res.json({ success: true, message: "Bar icon uploaded", data: { logo_path: filePath, bar_icon: filePath } });
    } catch (err) {
      console.error("BAR ICON UPLOAD ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ POST BAR GIF (file upload for bar gif/media) â”€â”€â”€
router.post(
  "/bar/gif",
  requireAuth,
  requirePermission("bar_details_update"),
  barGifUpload.single("bar_gif"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

      const filePath = req.file.path.replace(/\\/g, "/");
      const [result] = await pool.query(
        "UPDATE bars SET video_path = ?, updated_at = NOW() WHERE id = ?",
        [filePath, barId]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "Bar not found" });
      }

      return res.json({ success: true, message: "Bar GIF uploaded", data: { video_path: filePath, bar_gif: filePath } });
    } catch (err) {
      console.error("BAR GIF UPLOAD ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: Followers summary + recent followers â”€â”€â”€
router.get(
  "/bar/followers",
  requireAuth,
  requirePermission(["staff_view", "bar_details_view"]),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [[countRow]] = await pool.query(
        "SELECT COUNT(*) AS follower_count FROM bar_followers WHERE bar_id = ?",
        [barId]
      );

      const [recentRows] = await pool.query(
        `SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.profile_picture,
                bf.created_at AS followed_at
         FROM bar_followers bf
         JOIN users u ON u.id = bf.user_id
         WHERE bf.bar_id = ?
         ORDER BY bf.created_at DESC
         LIMIT 25`,
        [barId]
      );

      return res.json({
        success: true,
        data: {
          follower_count: Number(countRow?.follower_count || 0),
          recent_followers: recentRows,
        },
      });
    } catch (err) {
      console.error("OWNER FOLLOWERS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: List bar posts for current bar â”€â”€â”€
router.get(
  "/bar/posts",
  requireAuth,
  requirePermission("events_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) {
        return res.status(400).json({ success: false, message: "No bar_id on account" });
      }

      const [rows] = await pool.query(
        `SELECT bp.id, bp.bar_id, bp.user_id, bp.content, bp.image_path, bp.status,
                bp.like_count, bp.comment_count, bp.created_at, bp.updated_at,
                u.first_name, u.last_name
         FROM bar_posts bp
         LEFT JOIN users u ON u.id = bp.user_id
         WHERE bp.bar_id = ? AND bp.status = 'active'
         ORDER BY bp.created_at DESC
         LIMIT 200`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("OWNER LIST BAR POSTS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: Soft-delete a bar post â”€â”€â”€
router.delete(
  "/bar/posts/:id",
  requireAuth,
  requirePermission("events_delete"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const postId = Number(req.params.id);
      if (!barId) {
        return res.status(400).json({ success: false, message: "No bar_id on account" });
      }
      if (!Number.isInteger(postId) || postId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid post id" });
      }

      const [result] = await pool.query(
        "UPDATE bar_posts SET status = 'deleted', updated_at = NOW() WHERE id = ? AND bar_id = ?",
        [postId, barId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({ success: false, message: "Post not found" });
      }

      return res.json({ success: true, message: "Post deleted" });
    } catch (err) {
      console.error("OWNER DELETE BAR POST ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: List customers related to this bar (reservations/reviews/follows) â”€â”€â”€
router.get(
  "/bar/customers",
  requireAuth,
  requirePermission("ban_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.phone_number, u.profile_picture,
                MAX(x.last_interaction_at) AS last_interaction_at,
                CASE WHEN cbb.customer_id IS NULL THEN 0 ELSE 1 END AS is_banned,
                cbb.banned_at
         FROM users u
         JOIN (
           SELECT customer_user_id AS user_id, MAX(created_at) AS last_interaction_at
           FROM reservations
           WHERE bar_id = ? AND customer_user_id IS NOT NULL
           GROUP BY customer_user_id
           UNION ALL
           SELECT customer_id AS user_id, MAX(created_at) AS last_interaction_at
           FROM reviews
           WHERE bar_id = ?
           GROUP BY customer_id
           UNION ALL
           SELECT bf.user_id AS user_id, MAX(bf.created_at) AS last_interaction_at
           FROM bar_followers bf
           WHERE bf.bar_id = ?
           GROUP BY bf.user_id
         ) x ON x.user_id = u.id
         LEFT JOIN customer_bar_bans cbb
           ON cbb.bar_id = ? AND cbb.customer_id = u.id
         GROUP BY u.id, u.first_name, u.last_name, u.email, u.phone_number, u.profile_picture, cbb.customer_id, cbb.banned_at
         ORDER BY last_interaction_at DESC
         LIMIT 500`,
        [barId, barId, barId, barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("OWNER LIST CUSTOMERS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: Ban customer for this bar â”€â”€â”€
router.post(
  "/bar/customers/:id/ban",
  requireAuth,
  requirePermission("ban_branch"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const customerId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!customerId) return res.status(400).json({ success: false, message: "Invalid customer id" });

      const [[userRow]] = await pool.query(
        "SELECT id, role FROM users WHERE id = ? LIMIT 1",
        [customerId]
      );
      if (!userRow) return res.status(404).json({ success: false, message: "Customer not found" });
      if (String(userRow.role || "").toLowerCase() !== USER_ROLES.CUSTOMER) {
        return res.status(400).json({ success: false, message: "Selected user is not a customer" });
      }

      await pool.query(
        "INSERT IGNORE INTO customer_bar_bans (bar_id, customer_id) VALUES (?, ?)",
        [barId, customerId]
      );

      return res.json({ success: true, message: "Customer banned successfully" });
    } catch (err) {
      console.error("OWNER BAN CUSTOMER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: Unban customer for this bar â”€â”€â”€
router.delete(
  "/bar/customers/:id/ban",
  requireAuth,
  requirePermission("ban_lift"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const customerId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!customerId) return res.status(400).json({ success: false, message: "Invalid customer id" });

      await pool.query(
        "DELETE FROM customer_bar_bans WHERE bar_id = ? AND customer_id = ?",
        [barId, customerId]
      );

      return res.json({ success: true, message: "Customer unbanned successfully" });
    } catch (err) {
      console.error("OWNER UNBAN CUSTOMER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: List bar + event comments for moderation â”€â”€â”€
router.get(
  "/bar/comments",
  requireAuth,
  requirePermission("events_comment_manage"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const source = String(req.query.source || "all").toLowerCase();
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const data = { post_comments: [], event_comments: [] };

      if (source === "all" || source === "post") {
        const [postComments] = await pool.query(
          `SELECT c.id, c.post_id, c.user_id, c.comment, c.created_at,
                  u.first_name, u.last_name,
                  bp.bar_id
           FROM bar_post_comments c
           JOIN bar_posts bp ON bp.id = c.post_id
           JOIN users u ON u.id = c.user_id
           WHERE bp.bar_id = ?
           ORDER BY c.created_at DESC
           LIMIT 500`,
          [barId]
        );
        data.post_comments = postComments;
      }

      if (source === "all" || source === "event") {
        const [eventComments] = await pool.query(
          `SELECT ec.id, ec.event_id, ec.user_id, ec.comment, ec.status, ec.created_at, ec.updated_at,
                  u.first_name, u.last_name,
                  be.title AS event_title
           FROM event_comments ec
           JOIN bar_events be ON be.id = ec.event_id
           JOIN users u ON u.id = ec.user_id
           WHERE be.bar_id = ?
           ORDER BY ec.created_at DESC
           LIMIT 500`,
          [barId]
        );
        data.event_comments = eventComments;
      }

      return res.json({ success: true, data });
    } catch (err) {
      console.error("OWNER COMMENTS LIST ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: Delete an inappropriate bar-post comment â”€â”€â”€
router.delete(
  "/bar/comments/posts/:id",
  requireAuth,
  requirePermission("events_comment_manage"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const commentId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!commentId) return res.status(400).json({ success: false, message: "Invalid comment id" });

      const [result] = await pool.query(
        `DELETE c FROM bar_post_comments c
         JOIN bar_posts bp ON bp.id = c.post_id
         WHERE c.id = ? AND bp.bar_id = ?`,
        [commentId, barId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({ success: false, message: "Comment not found" });
      }

      return res.json({ success: true, message: "Comment deleted" });
    } catch (err) {
      console.error("OWNER DELETE POST COMMENT ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// â”€â”€â”€ OWNER: Moderate event comment (soft-delete) â”€â”€â”€
router.delete(
  "/bar/comments/events/:id",
  requireAuth,
  requirePermission("events_comment_manage"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const commentId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!commentId) return res.status(400).json({ success: false, message: "Invalid comment id" });

      const [result] = await pool.query(
        `UPDATE event_comments ec
         JOIN bar_events be ON be.id = ec.event_id
         SET ec.status = 'deleted', ec.updated_at = NOW()
         WHERE ec.id = ? AND be.bar_id = ?`,
        [commentId, barId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({ success: false, message: "Comment not found" });
      }

      return res.json({ success: true, message: "Event comment moderated" });
    } catch (err) {
      console.error("OWNER MODERATE EVENT COMMENT ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════
// STAFF MANAGEMENT (continued)
// ═══════════════════════════════════════════

// ─── OWNER: Reset staff password ───
router.post(
  "/bar/users/:id/reset-password",
  requireAuth,
  requirePermission("staff_reset_password"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = Number(req.params.id);
      const { new_password } = req.body;

      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!userId) return res.status(400).json({ success: false, message: "Invalid user ID" });
      if (!new_password || new_password.length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      }

      const [[user]] = await pool.query(
        "SELECT id FROM users WHERE id = ? AND bar_id = ? LIMIT 1",
        [userId, barId]
      );
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      const bcrypt = require("bcryptjs");
      const hashed = await bcrypt.hash(new_password, 10);
      await pool.query("UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?", [hashed, userId]);

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "RESET_USER_PASSWORD", entity: "users", entity_id: userId,
        details: {}, ...auditContext(req)
      });

      return res.json({ success: true, message: "Password reset successfully" });
    } catch (err) {
      console.error("RESET PASSWORD ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─── OWNER: List bar staff ───
router.get(
  "/bar/users/meta",
  requireAuth,
  requirePermission("staff_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const staffTypes = await getBarStaffTypes(barId);
      const supportsStaffType = await hasUserStaffTypeColumn();

      return res.json({ success: true, data: { staff_types: staffTypes, supports_staff_type: supportsStaffType } });
    } catch (err) {
      console.error("BAR USERS META ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.get(
  "/bar/users",
  requireAuth,
  requirePermission("staff_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const staffTypeSelect = await hasUserStaffTypeColumn()
        ? ", u.staff_type"
        : ", NULL AS staff_type";

      const [rows] = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.phone_number, u.role, u.role_id,
                u.is_active, u.profile_picture, u.created_at, u.updated_at${staffTypeSelect},
                r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.bar_id = ? AND u.is_active = 1 AND u.role != 'customer'
         ORDER BY u.created_at DESC`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("LIST USERS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─── OWNER: Toggle user active/deactivate ───
router.post(
  "/bar/users/:id/toggle",
  requireAuth,
  requirePermission("staff_deactivate"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!userId) return res.status(400).json({ success: false, message: "Invalid user ID" });

      const [[user]] = await pool.query(
        "SELECT id, is_active FROM users WHERE id = ? AND bar_id = ? LIMIT 1",
        [userId, barId]
      );
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      const newStatus = user.is_active ? 0 : 1;
      await pool.query("UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?", [newStatus, userId]);

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: newStatus ? "ACTIVATE_USER" : "DEACTIVATE_USER",
        entity: "users", entity_id: userId,
        details: { new_status: newStatus }, ...auditContext(req)
      });

      return res.json({ success: true, message: newStatus ? "User activated" : "User deactivated" });
    } catch (err) {
      console.error("TOGGLE USER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─── OWNER: List archived (soft-deleted) users ───
router.get(
  "/bar/users/archived",
  requireAuth,
  requirePermission("staff_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const staffTypeSelect = await hasUserStaffTypeColumn()
        ? ", u.staff_type"
        : ", NULL AS staff_type";

      const [rows] = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.phone_number, u.role,
                u.is_active, u.profile_picture, u.created_at, u.updated_at${staffTypeSelect}
         FROM users u
         WHERE u.bar_id = ? AND u.is_active = 0 AND u.role != 'customer'
         ORDER BY u.updated_at DESC`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("ARCHIVED USERS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─── OWNER: Restore a deactivated user ───
router.post(
  "/bar/users/:id/restore",
  requireAuth,
  requirePermission("staff_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [result] = await pool.query(
        "UPDATE users SET is_active = 1, updated_at = NOW() WHERE id = ? AND bar_id = ?",
        [userId, barId]
      );

      if (!result.affectedRows) return res.status(404).json({ success: false, message: "User not found" });

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "RESTORE_USER", entity: "users", entity_id: userId,
        details: {}, ...auditContext(req)
      });

      return res.json({ success: true, message: "User restored" });
    } catch (err) {
      console.error("RESTORE USER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─── OWNER: Permanently delete a user ───
router.post(
  "/bar/users/:id/permanent-delete",
  requireAuth,
  requirePermission("staff_delete"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [result] = await pool.query(
        "DELETE FROM users WHERE id = ? AND bar_id = ? AND is_active = 0",
        [userId, barId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({ success: false, message: "User not found or still active" });
      }

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "PERMANENT_DELETE_USER", entity: "users", entity_id: userId,
        details: {}, ...auditContext(req)
      });

      return res.json({ success: true, message: "User permanently deleted" });
    } catch (err) {
      console.error("PERMANENT DELETE USER ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// GET /owner/bar/events/analytics â€” likes/comments/reservations per event
router.get(
  "/bar/events/analytics",
  requireAuth,
  requirePermission("bar_details_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT be.id, be.title, be.event_date, be.status,
                (SELECT COUNT(*) FROM event_likes el WHERE el.event_id = be.id) AS like_count,
                (SELECT COUNT(*) FROM event_comments ec WHERE ec.event_id = be.id AND ec.status = 'active') AS comment_count,
                (SELECT COUNT(*) FROM reservations r WHERE r.event_id = be.id AND r.status IN ('pending','approved')) AS reservation_count
         FROM bar_events be
         WHERE be.bar_id = ? AND be.archived_at IS NULL
         ORDER BY be.event_date DESC, be.start_time DESC`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("OWNER EVENT ANALYTICS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// GET /owner/bar/customer-insights â€” top/frequent customers by reservations
router.get(
  "/bar/customer-insights",
  requireAuth,
  requirePermission("analytics_bar_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT u.id AS customer_id, u.first_name, u.last_name, u.email,
                COUNT(*) AS reservation_count,
                MAX(r.created_at) AS last_reservation_at
         FROM reservations r
         JOIN users u ON u.id = r.customer_user_id
         WHERE r.bar_id = ?
         GROUP BY u.id, u.first_name, u.last_name, u.email
         ORDER BY reservation_count DESC, last_reservation_at DESC
         LIMIT 20`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("OWNER CUSTOMER INSIGHTS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// GET /owner/bar/staff-performance â€” orders/reservations/attendance by staff
router.get(
  "/bar/staff-performance",
  requireAuth,
  requirePermission("staff_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT u.id AS user_id, u.first_name, u.last_name, u.role,
                (
                  SELECT COUNT(*)
                  FROM pos_orders po
                  WHERE po.bar_id = u.bar_id
                    AND po.staff_user_id = u.id
                ) AS orders_processed,
                (
                  SELECT COUNT(*)
                  FROM audit_logs al
                  WHERE al.bar_id = u.bar_id
                    AND al.user_id = u.id
                    AND al.action IN ('CREATE_RESERVATION','APPROVE_RESERVATION','REJECT_RESERVATION','CANCEL_RESERVATION')
                ) AS reservations_handled,
                (
                  SELECT COUNT(*)
                  FROM attendance a
                  WHERE a.user_id = u.id
                ) AS attendance_records
         FROM users u
         WHERE u.bar_id = ?
           AND u.is_active = 1
           AND LOWER(u.role) IN ('staff','cashier','manager','hr')
         ORDER BY orders_processed DESC, reservations_handled DESC, attendance_records DESC`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("OWNER STAFF PERFORMANCE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// GET /owner/bar/dashboard/summary â€” consolidated owner dashboard metrics
router.get(
  "/bar/dashboard/summary",
  requireAuth,
  requirePermission(["bar_details_view", "reservation_view", "menu_view"]),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [reservationsTodayRows] = await pool.query(
        `SELECT COUNT(*) AS count
         FROM reservations
         WHERE bar_id = ? AND reservation_date = CURDATE()`,
        [barId]
      );

      const [upcomingEventsRows] = await pool.query(
        `SELECT COUNT(*) AS count
         FROM bar_events
         WHERE bar_id = ? AND archived_at IS NULL AND status NOT IN ('cancelled') AND event_date >= CURDATE()`,
        [barId]
      );

      const [lowStockRows] = await pool.query(
        `SELECT id, name, stock_qty, reorder_level, unit,
                CASE
                  WHEN COALESCE(stock_qty, 0) <= 0 THEN 'critical'
                  WHEN COALESCE(stock_qty, 0) < COALESCE(reorder_level, 0) THEN 'low'
                  ELSE 'normal'
                END AS stock_status
         FROM inventory_items
         WHERE bar_id = ? AND is_active = 1
           AND (COALESCE(stock_qty, 0) < COALESCE(reorder_level, 0))
         ORDER BY 
           CASE
             WHEN COALESCE(stock_qty, 0) <= 0 THEN 1
             ELSE 2
           END,
           stock_qty ASC
         LIMIT 10`,
        [barId]
      );

      const [recentActivityRows] = await pool.query(
        `SELECT al.id, al.action, al.created_at,
                u.id AS user_id, u.first_name, u.last_name, u.role
         FROM audit_logs al
         JOIN users u ON u.id = al.user_id
         WHERE al.bar_id = ?
         ORDER BY al.created_at DESC
         LIMIT 10`,
        [barId]
      );

      const [topMenuRows] = await pool.query(
        `SELECT m.id, m.menu_name,
                COALESCE(SUM(poi.quantity), 0) AS total_sold
         FROM menu_items m
         LEFT JOIN pos_order_items poi ON poi.menu_item_id = m.id
         LEFT JOIN pos_orders po ON po.id = poi.order_id AND po.status = 'completed'
         WHERE m.bar_id = ?
         GROUP BY m.id, m.menu_name
         ORDER BY total_sold DESC, m.menu_name ASC
         LIMIT 5`,
        [barId]
      );

      const [todayRevenueRows] = await pool.query(
        `SELECT
           COALESCE(SUM(po.total_amount), 0) AS revenue,
           COUNT(po.id) AS orders
         FROM pos_orders po
         WHERE po.bar_id = ? AND po.status IN ('completed','paid')
           AND DATE(COALESCE(po.completed_at, po.updated_at)) = CURDATE()`,
        [barId]
      );

      // Include customer online payments (reservations + orders via PayMongo)
      const [todayPaymentRows] = await pool.query(
        `SELECT
           COALESCE(SUM(pt.amount), 0) AS payment_revenue,
           COUNT(*) AS payment_count,
           COALESCE(SUM(CASE WHEN pt.payment_type = 'reservation' THEN pt.amount ELSE 0 END), 0) AS reservation_revenue,
           SUM(CASE WHEN pt.payment_type = 'reservation' THEN 1 ELSE 0 END) AS paid_reservations
         FROM payment_transactions pt
         WHERE pt.bar_id = ? AND pt.status = 'paid'
           AND DATE(COALESCE(pt.paid_at, pt.updated_at)) = CURDATE()`,
        [barId]
      );

      // Reservation deposits for today's reservations (by reservation_date, not created_at)
      const [todayDepositRows] = await pool.query(
        `SELECT COALESCE(SUM(r.deposit_amount), 0) AS deposit_revenue, COUNT(*) AS deposit_count
         FROM reservations r
         WHERE r.bar_id = ? AND r.deposit_amount > 0
           AND r.status NOT IN ('rejected','cancelled')
           AND r.reservation_date = CURDATE()
           AND NOT EXISTS (
             SELECT 1 FROM payment_transactions pt
             WHERE pt.id = r.payment_transaction_id AND pt.status = 'paid'
           )`,
        [barId]
      );

      const posRevenue = Number(todayRevenueRows[0]?.revenue || 0);
      const paymentRevenue = Number(todayPaymentRows[0]?.payment_revenue || 0);
      const depositRevenue = Number(todayDepositRows[0]?.deposit_revenue || 0);

      return res.json({
        success: true,
        data: {
          reservations_today: Number(reservationsTodayRows[0]?.count || 0),
          upcoming_events: Number(upcomingEventsRows[0]?.count || 0),
          low_stock_alerts: lowStockRows,
          recent_staff_activity: recentActivityRows,
          top_menu_items: topMenuRows,
          today_revenue: posRevenue + paymentRevenue + depositRevenue,
          today_orders: Number(todayRevenueRows[0]?.orders || 0),
          today_pos_revenue: posRevenue,
          today_payment_revenue: paymentRevenue,
          today_paid_reservations: Number(todayPaymentRows[0]?.paid_reservations || 0),
          today_reservation_revenue: Number(todayPaymentRows[0]?.reservation_revenue || 0),
          today_pos_orders: Number(todayRevenueRows[0]?.orders || 0),
        },
      });
    } catch (err) {
      console.error("OWNER DASHBOARD SUMMARY ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════
// TABLE MANAGEMENT
// ═══════════════════════════════════════════

router.get(
  "/bar/tables/status",
  requireAuth,
  requirePermission("table_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const date = req.query.date || new Date().toISOString().split('T')[0];

      const [tables] = await pool.query(
        `SELECT t.id, t.table_number, t.floor_assignment, t.table_size, t.capacity, t.is_active, t.image_path, t.price, t.manual_status,
                CASE
                  WHEN t.manual_status = 'unavailable' THEN 'unavailable'
                  WHEN t.is_active = 0 THEN 'unavailable'
                  WHEN EXISTS (
                    SELECT 1 FROM reservations r
                    WHERE r.table_id = t.id AND r.reservation_date = ? AND r.status IN ('pending','approved','paid','confirmed','checked_in')
                  ) THEN 'reserved'
                  ELSE COALESCE(t.manual_status, 'available')
                END AS status
         FROM bar_tables t
         WHERE t.bar_id = ? AND t.deleted_at IS NULL
         ORDER BY t.table_number ASC`,
        [date, barId]
      );

      return res.json({ success: true, data: { tables, date } });
    } catch (err) {
      console.error("TABLE STATUS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.get(
  "/bar/tables",
  requireAuth,
  requirePermission("table_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT id, table_number, floor_assignment, table_size, capacity, is_active, image_path, price, manual_status, created_at
         FROM bar_tables WHERE bar_id = ? AND deleted_at IS NULL ORDER BY table_number ASC`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("LIST TABLES ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.post(
  "/bar/tables",
  requireAuth,
  requirePermission("table_update"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const { table_number, capacity, price, floor_assignment, table_size } = req.body || {};
      if (!table_number) return res.status(400).json({ success: false, message: "table_number required" });
      if (!capacity) return res.status(400).json({ success: false, message: "capacity required" });
      if (!table_size) return res.status(400).json({ success: false, message: "table_size required" });

      const [existing] = await pool.query(
        "SELECT id FROM bar_tables WHERE bar_id = ? AND table_number = ? AND deleted_at IS NULL LIMIT 1",
        [barId, table_number]
      );
      if (existing.length) return res.status(409).json({ success: false, message: "Table number already exists" });

      const [result] = await pool.query(
        `INSERT INTO bar_tables (bar_id, table_number, floor_assignment, capacity, table_size, price, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [barId, table_number, floor_assignment || null, capacity, table_size, price || null]
      );

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "CREATE_TABLE", entity: "bar_tables", entity_id: result.insertId,
        details: { table_number, floor_assignment, capacity, table_size, price }, ...auditContext(req)
      });

      return res.status(201).json({ success: true, message: "Table created", data: { id: result.insertId } });
    } catch (err) {
      console.error("CREATE TABLE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.patch(
  "/bar/tables/:id",
  requireAuth,
  requirePermission("table_update"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

      const allowed = ["table_number", "floor_assignment", "capacity", "table_size", "is_active", "price", "manual_status"];
      const updates = [];
      const params = [];

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates.push(`${key} = ?`);
          params.push(req.body[key]);
        }
      }

      if (!updates.length) return res.status(400).json({ success: false, message: "No fields to update" });

      params.push(id, barId);

      const [result] = await pool.query(
        `UPDATE bar_tables SET ${updates.join(", ")} WHERE id = ? AND bar_id = ? AND deleted_at IS NULL`,
        params
      );

      if (!result.affectedRows) return res.status(404).json({ success: false, message: "Table not found" });

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "UPDATE_TABLE", entity: "bar_tables", entity_id: id,
        details: { fields_updated: Object.keys(req.body).filter(k => allowed.includes(k)) },
        ...auditContext(req)
      });

      return res.json({ success: true, message: "Table updated" });
    } catch (err) {
      console.error("UPDATE TABLE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.delete(
  "/bar/tables/:id",
  requireAuth,
  requirePermission("table_update"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [result] = await pool.query(
        "UPDATE bar_tables SET deleted_at = NOW(), is_active = 0 WHERE id = ? AND bar_id = ? AND deleted_at IS NULL",
        [id, barId]
      );

      if (!result.affectedRows) return res.status(404).json({ success: false, message: "Table not found" });

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "DELETE_TABLE", entity: "bar_tables", entity_id: id,
        details: {}, ...auditContext(req)
      });

      return res.json({ success: true, message: "Table deleted" });
    } catch (err) {
      console.error("DELETE TABLE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.post(
  "/bar/tables/:id/image",
  requireAuth,
  requirePermission("table_update"),
  tableImageUpload.single("image"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

      const filePath = req.file.path.replace(/\\/g, "/");
      const [result] = await pool.query(
        "UPDATE bar_tables SET image_path = ? WHERE id = ? AND bar_id = ? AND deleted_at IS NULL",
        [filePath, id, barId]
      );

      if (!result.affectedRows) return res.status(404).json({ success: false, message: "Table not found" });

      return res.json({ success: true, message: "Table image uploaded", data: { image_path: filePath } });
    } catch (err) {
      console.error("TABLE IMAGE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════
// EVENTS MANAGEMENT
// ═══════════════════════════════════════════

router.get(
  "/bar/events",
  requireAuth,
  requirePermission("events_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT id, title, description, event_date, start_time, end_time,
                image_path, image_url, status, max_capacity, entry_price, current_bookings, created_at, updated_at
         FROM bar_events WHERE bar_id = ? AND status != 'deleted'
         ORDER BY event_date DESC`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("LIST EVENTS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.get(
  "/bar/events/:id/details",
  requireAuth,
  requirePermission("events_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [[event]] = await pool.query(
        `SELECT e.*, 
                (SELECT COUNT(*) FROM event_likes el WHERE el.event_id = e.id) AS like_count,
                (SELECT COUNT(*) FROM event_comments ec WHERE ec.event_id = e.id AND ec.status = 'active') AS comment_count
         FROM bar_events e WHERE e.id = ? AND e.bar_id = ? LIMIT 1`,
        [id, barId]
      );

      if (!event) return res.status(404).json({ success: false, message: "Event not found" });

      const [comments] = await pool.query(
        `SELECT ec.id, ec.user_id, ec.comment, ec.status, ec.created_at,
                u.first_name, u.last_name
         FROM event_comments ec
         JOIN users u ON u.id = ec.user_id
         WHERE ec.event_id = ? AND ec.status = 'active'
         ORDER BY ec.created_at DESC LIMIT 100`,
        [id]
      );

      // Fetch replies for each comment
      for (const comment of comments) {
        const [replies] = await pool.query(
          `SELECT r.id, r.event_comment_id, r.user_id, r.reply, r.status, r.created_at,
                  u.first_name, u.last_name, u.profile_picture, u.role
           FROM event_comment_replies r
           JOIN users u ON u.id = r.user_id
           WHERE r.event_comment_id = ? AND r.status = 'active'
           ORDER BY r.created_at ASC`,
          [comment.id]
        );
        comment.replies = replies;
      }

      return res.json({ success: true, data: { ...event, comments } });
    } catch (err) {
      console.error("EVENT DETAIL ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.get(
  "/bar/events/archived",
  requireAuth,
  requirePermission("events_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT id, title, description, event_date, status, image_path, updated_at
         FROM bar_events WHERE bar_id = ? AND status = 'deleted'
         ORDER BY updated_at DESC`,
        [barId]
      );

      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("ARCHIVED EVENTS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// Helper function to validate event time against bar operating hours
function buildEventOperatingHoursMap(barRow) {
  if (!barRow || typeof barRow !== 'object') return null;

  const mapLegacyDay = (value) => {
    const text = String(value || '').trim();
    if (!text) return null;
    const parts = text.split(/[–-]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    return { open: parts[0], close: parts[1] };
  };

  const map = {
    Monday: mapLegacyDay(barRow.monday_hours),
    Tuesday: mapLegacyDay(barRow.tuesday_hours),
    Wednesday: mapLegacyDay(barRow.wednesday_hours),
    Thursday: mapLegacyDay(barRow.thursday_hours),
    Friday: mapLegacyDay(barRow.friday_hours),
    Saturday: mapLegacyDay(barRow.saturday_hours),
    Sunday: mapLegacyDay(barRow.sunday_hours),
  };

  return map;
}

function isEventWithinOperatingHours(eventDate, startTime, endTime, operatingHours) {
  if (!operatingHours || !startTime || !endTime) return true; // Skip validation if data missing
  
  try {
    const eventDay = new Date(eventDate).toLocaleDateString('en-US', { weekday: 'long' });
    const hours = typeof operatingHours === 'string'
      ? JSON.parse(operatingHours)
      : (operatingHours.operating_hours ? (typeof operatingHours.operating_hours === 'string' ? JSON.parse(operatingHours.operating_hours) : operatingHours.operating_hours) : buildEventOperatingHoursMap(operatingHours));
    
    if (!hours || typeof hours !== 'object') return true;
    
    const daySchedule = hours[eventDay];
    if (!daySchedule || daySchedule.closed) {
      return { valid: false, message: `Bar is closed on ${eventDay}` };
    }
    
    const barOpen = daySchedule.open;
    const barClose = daySchedule.close;
    
    if (!barOpen || !barClose) return true;
    
    // Convert times to minutes for comparison
    const toMinutes = (time) => {
      const value = String(time || '').trim();
      const ampmMatch = value.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))$/i);
      if (ampmMatch) {
        let hours = Number(ampmMatch[1]) || 0;
        const minutes = Number(ampmMatch[2]) || 0;
        const meridiem = String(ampmMatch[3] || '').toUpperCase();
        if (meridiem === 'PM' && hours !== 12) hours += 12;
        if (meridiem === 'AM' && hours === 12) hours = 0;
        return hours * 60 + minutes;
      }

      const plainMatch = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (plainMatch) {
        const hours = Number(plainMatch[1]) || 0;
        const minutes = Number(plainMatch[2]) || 0;
        return hours * 60 + minutes;
      }

      return NaN;
    };
    
    const eventStart = toMinutes(startTime);
    const eventEnd = toMinutes(endTime);
    const barOpenMin = toMinutes(barOpen);
    const barCloseMin = toMinutes(barClose);
    
    if (eventStart < barOpenMin || eventEnd > barCloseMin) {
      return { 
        valid: false, 
        message: `Event time (${startTime} - ${endTime}) is outside bar operating hours (${barOpen} - ${barClose}) on ${eventDay}`
      };
    }
    
    return { valid: true };
  } catch (err) {
    console.error('Operating hours validation error:', err);
    return true; // Don't block on validation errors
  }
}

router.post(
  "/bar/events",
  requireAuth,
  requirePermission("events_create"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const { title, description, event_date, start_time, end_time, entry_price, max_capacity } = req.body || {};
      if (!title || !event_date) return res.status(400).json({ success: false, message: "title and event_date required" });

      // Get bar operating hours using schema-safe day fields
      const [barData] = await pool.query(
        `SELECT monday_hours, tuesday_hours, wednesday_hours, thursday_hours,
                friday_hours, saturday_hours, sunday_hours
         FROM bars WHERE id = ?`,
        [barId]
      );
      if (barData.length > 0) {
        const validation = isEventWithinOperatingHours(event_date, start_time, end_time, barData[0]);
        if (validation && !validation.valid) {
          return res.status(400).json({ success: false, message: validation.message });
        }
      }

      const [result] = await pool.query(
        `INSERT INTO bar_events (bar_id, title, description, event_date, start_time, end_time, entry_price, max_capacity, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [barId, title, description || null, event_date, start_time || null, end_time || null, entry_price || null, max_capacity || null]
      );

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "CREATE_EVENT", entity: "bar_events", entity_id: result.insertId,
        details: { title, event_date }, ...auditContext(req)
      });

      return res.status(201).json({ success: true, message: "Event created", data: { id: result.insertId } });
    } catch (err) {
      console.error("CREATE EVENT ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.patch(
  "/bar/events/:id",
  requireAuth,
  requirePermission("events_update"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

      // If updating event time, validate against operating hours
      if (req.body.event_date || req.body.start_time || req.body.end_time) {
        const [existingEvent] = await pool.query(
          'SELECT event_date, start_time, end_time FROM bar_events WHERE id = ? AND bar_id = ?',
          [id, barId]
        );
        
        if (existingEvent.length > 0) {
          const eventDate = req.body.event_date || existingEvent[0].event_date;
          const startTime = req.body.start_time || existingEvent[0].start_time;
          const endTime = req.body.end_time || existingEvent[0].end_time;
          
          const [barData] = await pool.query(
            `SELECT monday_hours, tuesday_hours, wednesday_hours, thursday_hours,
                    friday_hours, saturday_hours, sunday_hours
             FROM bars WHERE id = ?`,
            [barId]
          );
          if (barData.length > 0) {
            const validation = isEventWithinOperatingHours(eventDate, startTime, endTime, barData[0]);
            if (validation && !validation.valid) {
              return res.status(400).json({ success: false, message: validation.message });
            }
          }
        }
      }

      const allowed = ["title", "description", "event_date", "start_time", "end_time", "entry_price", "max_capacity", "status"];
      const updates = [];
      const params = [];

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates.push(`${key} = ?`);
          params.push(req.body[key]);
        }
      }

      if (!updates.length) return res.status(400).json({ success: false, message: "No fields to update" });

      updates.push("updated_at = NOW()");
      params.push(id, barId);

      const [result] = await pool.query(
        `UPDATE bar_events SET ${updates.join(", ")} WHERE id = ? AND bar_id = ?`,
        params
      );

      if (!result.affectedRows) return res.status(404).json({ success: false, message: "Event not found" });

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "UPDATE_EVENT", entity: "bar_events", entity_id: id,
        details: { fields_updated: Object.keys(req.body).filter(k => allowed.includes(k)) },
        ...auditContext(req)
      });

      return res.json({ success: true, message: "Event updated" });
    } catch (err) {
      console.error("UPDATE EVENT ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.delete(
  "/bar/events/:id",
  requireAuth,
  requirePermission("events_delete"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [result] = await pool.query(
        "UPDATE bar_events SET status = 'deleted', updated_at = NOW() WHERE id = ? AND bar_id = ?",
        [id, barId]
      );

      if (!result.affectedRows) return res.status(404).json({ success: false, message: "Event not found" });

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "DELETE_EVENT", entity: "bar_events", entity_id: id,
        details: {}, ...auditContext(req)
      });

      return res.json({ success: true, message: "Event deleted" });
    } catch (err) {
      console.error("DELETE EVENT ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.post(
  "/bar/events/:id/image",
  requireAuth,
  requirePermission("events_update"),
  eventImageUpload.single("image"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

      const filePath = req.file.path.replace(/\\/g, "/");
      const [result] = await pool.query(
        "UPDATE bar_events SET image_path = ?, updated_at = NOW() WHERE id = ? AND bar_id = ?",
        [filePath, id, barId]
      );

      if (!result.affectedRows) return res.status(404).json({ success: false, message: "Event not found" });

      return res.json({ success: true, message: "Event image uploaded", data: { image_path: filePath } });
    } catch (err) {
      console.error("EVENT IMAGE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════
// RBAC ENDPOINTS
// ═══════════════════════════════════════════

router.get(
  "/rbac/roles",
  requireAuth,
  requirePermission("staff_edit_permissions"),
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, name, description FROM roles
         WHERE name IN ('EMPLOYEE', 'MANAGER', 'BAR_OWNER')
         ORDER BY id ASC`
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("LIST ROLES ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.get(
  "/rbac/permissions",
  requireAuth,
  requirePermission("staff_edit_permissions"),
  async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, name, module, action, description
         FROM permissions
         WHERE name NOT IN ('ban_platform')
         ORDER BY module ASC, name ASC`
      );

      const data = rows.map((row) => ({
        ...row,
        display_name: toPermissionDisplayName(row.name),
        friendly_description: row.description || toPermissionFriendlyDescription(row.name),
      }));

      return res.json({ success: true, data });
    } catch (err) {
      console.error("LIST PERMISSIONS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.get(
  "/rbac/users/:id/permissions",
  requireAuth,
  requirePermission("staff_edit_permissions"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!userId) return res.status(400).json({ success: false, message: "Invalid user ID" });

      const [[user]] = await pool.query(
        "SELECT id, role_id FROM users WHERE id = ? AND bar_id = ? LIMIT 1",
        [userId, barId]
      );
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      // Check if user has overrides
      const [overrideCheck] = await pool.query(
        "SELECT 1 FROM user_permissions WHERE user_id = ? LIMIT 1",
        [userId]
      );

      if (overrideCheck.length > 0) {
        // Return user-specific permissions
        const [permissions] = await pool.query(
          `SELECT p.id, p.name, p.module, p.action, p.description, up.granted
           FROM user_permissions up
           JOIN permissions p ON p.id = up.permission_id
           WHERE up.user_id = ?
           ORDER BY p.module ASC, p.name ASC`,
          [userId]
        );
        return res.json({ success: true, data: permissions, has_overrides: true });
      }

      // Resolve effective role_id (may be null if user pre-dates migration)
      let effectiveRoleId = user.role_id;
      if (!effectiveRoleId) {
        const [[userRole]] = await pool.query(
          "SELECT id FROM roles WHERE UPPER(name) = UPPER((SELECT role FROM users WHERE id = ? LIMIT 1)) LIMIT 1",
          [userId]
        );
        effectiveRoleId = userRole?.id || null;
      }

      if (!effectiveRoleId) {
        return res.json({ success: true, data: [], has_overrides: false });
      }

      // Return role defaults
      const [permissions] = await pool.query(
        `SELECT p.id, p.name, p.module, p.action, p.description, 1 AS granted
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         ORDER BY p.module ASC, p.name ASC`,
        [effectiveRoleId]
      );
      return res.json({ success: true, data: permissions, has_overrides: false });
    } catch (err) {
      console.error("GET USER PERMISSIONS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.patch(
  "/rbac/users/:id/role",
  requireAuth,
  requirePermission("staff_edit_permissions"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = Number(req.params.id);
      const { role_id } = req.body;

      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!userId) return res.status(400).json({ success: false, message: "Invalid user ID" });
      if (!role_id) return res.status(400).json({ success: false, message: "role_id required" });

      const [[user]] = await pool.query(
        "SELECT id, role FROM users WHERE id = ? AND bar_id = ? LIMIT 1",
        [userId, barId]
      );
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      const [[role]] = await pool.query(
        "SELECT id, name FROM roles WHERE id = ? AND name IN ('EMPLOYEE', 'MANAGER') LIMIT 1",
        [role_id]
      );
      if (!role) return res.status(400).json({ success: false, message: "Invalid role or not assignable" });

      await pool.query(
        "UPDATE users SET role_id = ?, role = ?, updated_at = NOW() WHERE id = ? AND bar_id = ?",
        [role_id, role.name.toLowerCase(), userId, barId]
      );

      // Clear user overrides so they inherit new role defaults
      await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [userId]);

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "UPDATE_USER_ROLE", entity: "users", entity_id: userId,
        details: { new_role_id: role_id, new_role_name: role.name },
        ...auditContext(req)
      });

      return res.json({ success: true, message: "User role updated successfully" });
    } catch (err) {
      console.error("UPDATE USER ROLE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.patch(
  "/rbac/users/:id/permissions",
  requireAuth,
  requirePermission("staff_edit_permissions"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const userId = Number(req.params.id);
      const { permission_ids } = req.body;

      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!userId) return res.status(400).json({ success: false, message: "Invalid user ID" });
      if (!Array.isArray(permission_ids)) {
        return res.status(400).json({ success: false, message: "permission_ids must be an array" });
      }

      const [[user]] = await pool.query(
        "SELECT id FROM users WHERE id = ? AND bar_id = ? LIMIT 1",
        [userId, barId]
      );
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      // Delete existing user-specific permissions
      await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [userId]);

      // Insert new user-specific permissions (all granted = 1)
      if (permission_ids.length > 0) {
        const values = permission_ids.map(pid => [userId, Number(pid), 1, req.user.id]);
        await pool.query(
          "INSERT INTO user_permissions (user_id, permission_id, granted, granted_by) VALUES ?",
          [values]
        );
      }

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "UPDATE_USER_PERMISSIONS", entity: "user_permissions", entity_id: userId,
        details: { target_user_id: userId, permission_count: permission_ids.length },
        ...auditContext(req)
      });

      return res.json({ success: true, message: "Permissions updated successfully" });
    } catch (err) {
      console.error("UPDATE USER PERMISSIONS ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════
// POST /owner/bar/delete — soft-delete a bar
// ═══════════════════════════════════════════
router.post(
  "/bar/delete",
  requireAuth,
  async (req, res) => {
    try {
      const barId = Number(req.body.bar_id);
      if (!barId) return res.status(400).json({ success: false, message: "Bar ID required" });

      const [bars] = await pool.query(
        "SELECT id FROM bars WHERE id = ? LIMIT 1",
        [barId]
      );
      if (!bars.length) return res.status(404).json({ success: false, message: "Bar not found" });

      await pool.query("UPDATE bars SET status = 'deleted', updated_at = NOW() WHERE id = ?", [barId]);

      logAudit(null, {
        bar_id: barId, user_id: req.user.id,
        action: "DELETE_BAR", entity: "bars", entity_id: barId,
        details: {}, ...auditContext(req)
      });

      return res.json({ success: true, message: "Bar deleted" });
    } catch (err) {
      console.error("DELETE BAR ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════
// LIVE SALES FROM CUSTOMER PAYMENTS
// ═══════════════════════════════════════════

/**
 * GET /owner/bar/sales/today
 * Total paid reservations + revenue today from customer payments
 */
router.get(
  "/bar/sales/today",
  requireAuth,
  requirePermission("bar_details_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [rows] = await pool.query(
        `SELECT
           COUNT(*) AS total_transactions,
           COALESCE(SUM(pt.amount), 0) AS total_revenue,
           COALESCE(SUM(CASE WHEN pt.payment_type = 'reservation' THEN pt.amount ELSE 0 END), 0) AS reservation_revenue,
           SUM(CASE WHEN pt.payment_type = 'reservation' THEN 1 ELSE 0 END) AS paid_reservations,
           COALESCE(SUM(CASE WHEN pt.payment_type = 'order' THEN pt.amount ELSE 0 END), 0) AS order_revenue,
           SUM(CASE WHEN pt.payment_type = 'order' THEN 1 ELSE 0 END) AS paid_orders
         FROM payment_transactions pt
         WHERE pt.bar_id = ? AND pt.status = 'paid'
           AND DATE(COALESCE(pt.paid_at, pt.updated_at)) = CURDATE()`,
        [barId]
      );

      const [recentRows] = await pool.query(
        `SELECT pt.id, pt.reference_id, pt.payment_type, pt.amount, pt.payment_method, pt.paid_at,
                CONCAT(u.first_name, ' ', u.last_name) AS customer_name,
                r.transaction_number, r.reservation_date, r.reservation_time
         FROM payment_transactions pt
         LEFT JOIN users u ON u.id = pt.user_id
         LEFT JOIN reservations r ON pt.payment_type = 'reservation' AND pt.related_id = r.id
         WHERE pt.bar_id = ? AND pt.status = 'paid'
           AND DATE(COALESCE(pt.paid_at, pt.updated_at)) = CURDATE()
         ORDER BY COALESCE(pt.paid_at, pt.updated_at) DESC
         LIMIT 20`,
        [barId]
      );

      return res.json({ success: true, data: { summary: rows[0], recent_transactions: recentRows } });
    } catch (err) {
      console.error("OWNER SALES TODAY ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/**
 * GET /owner/bar/sales/summary
 * Weekly and monthly revenue breakdown from customer payments
 */
router.get(
  "/bar/sales/summary",
  requireAuth,
  requirePermission("bar_details_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [todayRows] = await pool.query(
        `SELECT SUM(cnt) AS total_transactions, SUM(rev) AS total_revenue
         FROM (
           SELECT COUNT(*) AS cnt, COALESCE(SUM(pt.amount), 0) AS rev
           FROM payment_transactions pt
           WHERE pt.bar_id = ? AND pt.status = 'paid'
             AND DATE(COALESCE(pt.paid_at, pt.updated_at)) = CURDATE()
           UNION ALL
           SELECT COUNT(*) AS cnt, COALESCE(SUM(po.total_amount), 0) AS rev
           FROM pos_orders po
           WHERE po.bar_id = ? AND po.status IN ('completed','paid')
             AND DATE(COALESCE(po.completed_at, po.updated_at)) = CURDATE()
           UNION ALL
           SELECT COUNT(*) AS cnt, COALESCE(SUM(r.deposit_amount), 0) AS rev
           FROM reservations r
           WHERE r.bar_id = ? AND r.deposit_amount > 0
             AND r.status NOT IN ('rejected','cancelled')
             AND r.reservation_date = CURDATE()
             AND NOT EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.id = r.payment_transaction_id AND pt.status = 'paid')
         ) combined`,
        [barId, barId, barId]
      );

      const [weekRows] = await pool.query(
        `SELECT SUM(cnt) AS total_transactions, SUM(rev) AS total_revenue
         FROM (
           SELECT COUNT(*) AS cnt, COALESCE(SUM(pt.amount), 0) AS rev
           FROM payment_transactions pt
           WHERE pt.bar_id = ? AND pt.status = 'paid'
             AND YEARWEEK(COALESCE(pt.paid_at, pt.updated_at), 1) = YEARWEEK(CURDATE(), 1)
           UNION ALL
           SELECT COUNT(*) AS cnt, COALESCE(SUM(po.total_amount), 0) AS rev
           FROM pos_orders po
           WHERE po.bar_id = ? AND po.status IN ('completed','paid')
             AND YEARWEEK(COALESCE(po.completed_at, po.updated_at), 1) = YEARWEEK(CURDATE(), 1)
           UNION ALL
           SELECT COUNT(*) AS cnt, COALESCE(SUM(r.deposit_amount), 0) AS rev
           FROM reservations r
           WHERE r.bar_id = ? AND r.deposit_amount > 0
             AND r.status IN ('approved','confirmed','paid')
             AND YEARWEEK(r.created_at, 1) = YEARWEEK(CURDATE(), 1)
             AND NOT EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.id = r.payment_transaction_id AND pt.status = 'paid')
         ) combined`,
        [barId, barId, barId]
      );

      const [monthRows] = await pool.query(
        `SELECT SUM(cnt) AS total_transactions, SUM(rev) AS total_revenue
         FROM (
           SELECT COUNT(*) AS cnt, COALESCE(SUM(pt.amount), 0) AS rev
           FROM payment_transactions pt
           WHERE pt.bar_id = ? AND pt.status = 'paid'
             AND MONTH(COALESCE(pt.paid_at, pt.updated_at)) = MONTH(CURDATE())
             AND YEAR(COALESCE(pt.paid_at, pt.updated_at)) = YEAR(CURDATE())
           UNION ALL
           SELECT COUNT(*) AS cnt, COALESCE(SUM(po.total_amount), 0) AS rev
           FROM pos_orders po
           WHERE po.bar_id = ? AND po.status IN ('completed','paid')
             AND MONTH(COALESCE(po.completed_at, po.updated_at)) = MONTH(CURDATE())
             AND YEAR(COALESCE(po.completed_at, po.updated_at)) = YEAR(CURDATE())
           UNION ALL
           SELECT COUNT(*) AS cnt, COALESCE(SUM(r.deposit_amount), 0) AS rev
           FROM reservations r
           WHERE r.bar_id = ? AND r.deposit_amount > 0
             AND r.status IN ('approved','confirmed','paid')
             AND MONTH(r.created_at) = MONTH(CURDATE()) AND YEAR(r.created_at) = YEAR(CURDATE())
             AND NOT EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.id = r.payment_transaction_id AND pt.status = 'paid')
         ) combined`,
        [barId, barId, barId, barId]
      );

      const [dailyRows] = await pool.query(
        `SELECT DATE(pt.paid_at) AS date,
                COUNT(*) AS transactions,
                COALESCE(SUM(pt.amount), 0) AS revenue
         FROM payment_transactions pt
         WHERE pt.bar_id = ? AND pt.status = 'paid'
           AND pt.paid_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
         GROUP BY DATE(pt.paid_at)
         ORDER BY date DESC`,
        [barId]
      );

      // Best seller: reservation_items + sales UNION ALL (last 30 days)
      const [bestSellerRows] = await pool.query(
        `SELECT ii.name, SUM(combined.qty) AS total_qty
         FROM inventory_items ii
         JOIN (
           SELECT s.item_id AS inv_id, s.quantity AS qty
           FROM sales s WHERE s.bar_id = ? AND s.sale_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)
           UNION ALL
           SELECT mi.inventory_item_id AS inv_id, ri.quantity AS qty
           FROM reservation_items ri
           JOIN menu_items mi ON mi.id = ri.menu_item_id AND mi.bar_id = ?
           WHERE ri.bar_id = ? AND ri.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         ) combined ON combined.inv_id = ii.id
         WHERE ii.bar_id = ?
         GROUP BY ii.id, ii.name ORDER BY total_qty DESC LIMIT 1`,
        [barId, barId, barId, barId]
      );

      return res.json({
        success: true,
        data: {
          today: { revenue: parseFloat(todayRows[0].total_revenue || 0), count: todayRows[0].total_transactions || 0 },
          week:  { revenue: parseFloat(weekRows[0].total_revenue || 0),  count: weekRows[0].total_transactions || 0 },
          month: { revenue: parseFloat(monthRows[0].total_revenue || 0), count: monthRows[0].total_transactions || 0 },
          best_seller: bestSellerRows.length ? { name: bestSellerRows[0].name, total_qty: bestSellerRows[0].total_qty } : null,
          this_week: weekRows[0],
          this_month: monthRows[0],
          daily_breakdown: dailyRows,
        },
      });
    } catch (err) {
      console.error("OWNER SALES SUMMARY ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// TAX CONFIGURATION (Bar Owner Panel — extensibility)
// ═══════════════════════════════════════════════════════════════════

// GET /owner/tax-config — Fetch bar's current tax configuration
router.get("/tax-config", requireAuth, requireRole([USER_ROLES.BAR_OWNER]), async (req, res) => {
  try {
    const barId = req.user.bar_id;
    if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

    const [rows] = await pool.query(
      `SELECT tin, is_bir_registered, tax_type, tax_rate, tax_mode
       FROM bars WHERE id = ? LIMIT 1`,
      [barId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Bar not found" });

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("GET TAX CONFIG ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// PUT /owner/tax-config — Update bar's tax configuration
router.put("/tax-config", requireAuth, requireRole([USER_ROLES.BAR_OWNER]), async (req, res) => {
  try {
    const barId = req.user.bar_id;
    if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

    const { tin, is_bir_registered, tax_type, tax_rate, tax_mode } = req.body || {};

    if (tax_type && !["VAT", "NON_VAT"].includes(tax_type)) {
      return res.status(400).json({ success: false, message: "tax_type must be VAT or NON_VAT" });
    }
    if (tax_mode && !["EXCLUSIVE", "INCLUSIVE"].includes(tax_mode)) {
      return res.status(400).json({ success: false, message: "tax_mode must be EXCLUSIVE or INCLUSIVE" });
    }
    if (tax_rate !== undefined && (Number(tax_rate) < 0 || Number(tax_rate) > 100)) {
      return res.status(400).json({ success: false, message: "tax_rate must be between 0 and 100" });
    }

    await pool.query(
      `UPDATE bars SET
         tin = COALESCE(?, tin),
         is_bir_registered = COALESCE(?, is_bir_registered),
         tax_type = COALESCE(?, tax_type),
         tax_rate = COALESCE(?, tax_rate),
         tax_mode = COALESCE(?, tax_mode),
         updated_at = NOW()
       WHERE id = ?`,
      [
        tin !== undefined ? tin : null,
        is_bir_registered !== undefined ? (is_bir_registered ? 1 : 0) : null,
        tax_type || null,
        tax_rate !== undefined ? Number(tax_rate) : null,
        tax_mode || null,
        barId,
      ]
    );

    logAudit(null, {
      bar_id: barId,
      user_id: req.user.id,
      action: "UPDATE_TAX_CONFIG",
      entity: "bars",
      entity_id: barId,
      details: { tin, is_bir_registered, tax_type, tax_rate, tax_mode },
      ...auditContext(req),
    });

    const [updated] = await pool.query(
      `SELECT tin, is_bir_registered, tax_type, tax_rate, tax_mode FROM bars WHERE id = ? LIMIT 1`,
      [barId]
    );

    return res.json({ success: true, message: "Tax configuration updated", data: updated[0] });
  } catch (err) {
    console.error("PUT TAX CONFIG ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═══════════════════════════════════════════
// PACKAGE MANAGEMENT
// ═══════════════════════════════════════════

// GET /owner/bar/packages — list packages for this bar
router.get(
  "/bar/packages",
  requireAuth,
  requirePermission("menu_view"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [packages] = await pool.query(
        `SELECT id, name, description, price, is_active, created_at, updated_at
         FROM bar_packages
         WHERE bar_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        [barId]
      );

      // Fetch inclusions for each package
      for (const pkg of packages) {
        const [inclusions] = await pool.query(
          `SELECT id, item_name, quantity
           FROM package_inclusions
           WHERE package_id = ?
           ORDER BY id ASC`,
          [pkg.id]
        );
        pkg.inclusions = inclusions;
      }

      return res.json({ success: true, data: packages });
    } catch (err) {
      console.error("LIST PACKAGES ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// POST /owner/bar/packages — create a new package
router.post(
  "/bar/packages",
  requireAuth,
  requirePermission("menu_create"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const barId = req.user.bar_id;
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const { name, description, price, inclusions } = req.body || {};
      if (!name) return res.status(400).json({ success: false, message: "Package name is required" });

      await conn.beginTransaction();

      // Create package
      const [result] = await conn.query(
        `INSERT INTO bar_packages (bar_id, name, description, price, is_active)
         VALUES (?, ?, ?, ?, 1)`,
        [barId, name, description || null, price || 0]
      );

      const packageId = result.insertId;

      // Insert inclusions if provided
      if (Array.isArray(inclusions) && inclusions.length > 0) {
        const validInclusions = inclusions.filter(
          (inc) => inc && inc.item_name && inc.item_name.trim()
        );
        if (validInclusions.length > 0) {
          const inclusionRows = validInclusions.map((inc) => [
            packageId,
            String(inc.item_name).trim(),
            Number(inc.quantity || 1),
          ]);
          await conn.query(
            `INSERT INTO package_inclusions (package_id, item_name, quantity) VALUES ?`,
            [inclusionRows]
          );
        }
      }

      await conn.commit();

      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action: "CREATE_PACKAGE",
        entity: "bar_packages",
        entity_id: packageId,
        details: { name, price, inclusions_count: inclusions?.length || 0 },
        ...auditContext(req)
      });

      return res.status(201).json({ success: true, message: "Package created", data: { id: packageId } });
    } catch (err) {
      await conn.rollback();
      console.error("CREATE PACKAGE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      conn.release();
    }
  }
);

// PATCH /owner/bar/packages/:id — update a package
router.patch(
  "/bar/packages/:id",
  requireAuth,
  requirePermission("menu_update"),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });
      if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

      const { name, description, price, is_active, inclusions } = req.body || {};

      await conn.beginTransaction();

      // Update package basic info
      const updates = [];
      const params = [];
      if (name !== undefined) { updates.push("name = ?"); params.push(name); }
      if (description !== undefined) { updates.push("description = ?"); params.push(description); }
      if (price !== undefined) { updates.push("price = ?"); params.push(Number(price)); }
      if (is_active !== undefined) { updates.push("is_active = ?"); params.push(is_active ? 1 : 0); }

      if (updates.length > 0) {
        updates.push("updated_at = NOW()");
        params.push(id, barId);
        const [result] = await conn.query(
          `UPDATE bar_packages SET ${updates.join(", ")} WHERE id = ? AND bar_id = ? AND deleted_at IS NULL`,
          params
        );
        if (!result.affectedRows) {
          await conn.rollback();
          return res.status(404).json({ success: false, message: "Package not found" });
        }
      }

      // Update inclusions if provided
      if (Array.isArray(inclusions)) {
        // Delete existing inclusions
        await conn.query("DELETE FROM package_inclusions WHERE package_id = ?", [id]);

        // Insert new inclusions
        const validInclusions = inclusions.filter(
          (inc) => inc && inc.item_name && inc.item_name.trim()
        );
        if (validInclusions.length > 0) {
          const inclusionRows = validInclusions.map((inc) => [
            id,
            String(inc.item_name).trim(),
            Number(inc.quantity || 1),
          ]);
          await conn.query(
            `INSERT INTO package_inclusions (package_id, item_name, quantity) VALUES ?`,
            [inclusionRows]
          );
        }
      }

      await conn.commit();

      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action: "UPDATE_PACKAGE",
        entity: "bar_packages",
        entity_id: id,
        details: { fields_updated: Object.keys(req.body) },
        ...auditContext(req)
      });

      return res.json({ success: true, message: "Package updated" });
    } catch (err) {
      await conn.rollback();
      console.error("UPDATE PACKAGE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      conn.release();
    }
  }
);

// DELETE /owner/bar/packages/:id — soft delete a package
router.delete(
  "/bar/packages/:id",
  requireAuth,
  requirePermission("menu_delete"),
  async (req, res) => {
    try {
      const barId = req.user.bar_id;
      const id = Number(req.params.id);
      if (!barId) return res.status(400).json({ success: false, message: "No bar_id on account" });

      const [result] = await pool.query(
        "UPDATE bar_packages SET deleted_at = NOW(), is_active = 0 WHERE id = ? AND bar_id = ? AND deleted_at IS NULL",
        [id, barId]
      );

      if (!result.affectedRows) return res.status(404).json({ success: false, message: "Package not found" });

      logAudit(null, {
        bar_id: barId,
        user_id: req.user.id,
        action: "DELETE_PACKAGE",
        entity: "bar_packages",
        entity_id: id,
        details: {},
        ...auditContext(req)
      });

      return res.json({ success: true, message: "Package deleted" });
    } catch (err) {
      console.error("DELETE PACKAGE ERROR:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─── OWNER: Change own password ───
router.post("/change-password", requireAuth, requireRole(USER_ROLES.BAR_OWNER), async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current password and new password are required" });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters" });
    }

    if (String(currentPassword).length > 128 || String(newPassword).length > 128) {
      return res.status(400).json({ success: false, message: "Password must be 128 characters or less" });
    }

    // Verify current password
    const [rows] = await pool.query("SELECT password FROM users WHERE id = ? LIMIT 1", [userId]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isValid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }

    // Hash new password and update
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?", [hashedPassword, userId]);

    await logAudit({
      user_id: userId,
      bar_id: req.user.bar_id,
      action: "CHANGE_PASSWORD",
      entity: "user",
      entity_id: userId,
      details: { message: "Bar owner changed their own password" },
      ...auditContext(req),
    });

    return res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    console.error("OWNER CHANGE PASSWORD ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
