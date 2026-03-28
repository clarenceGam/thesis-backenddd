const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { USER_ROLES } = require("../config/constants");
const { safeProfileUrl } = require("../utils/profileUrl");
const { logAudit, auditContext } = require("../utils/audit");
const { sendVerificationEmail, sendBarOwnerVerificationEmail, sendPasswordResetEmail } = require("../utils/emailService");
const { DEFAULT_AVATAR } = require("../utils/profileUrl");

let hasGlobalBanColumnCache = null;
let hasUserBanReasonColumnCache = null;
let hasBarSuspensionMessageColumnCache = null;
let maintenanceStateCache = {
  expiresAt: 0,
  maintenanceMode: false,
  maintenanceMessage: "",
};

async function hasGlobalBanColumn() {
  if (hasGlobalBanColumnCache !== null) return hasGlobalBanColumnCache;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM users LIKE 'is_banned'");
    hasGlobalBanColumnCache = rows.length > 0;
    return hasGlobalBanColumnCache;
  } catch (_) {
    hasGlobalBanColumnCache = false;
    return false;
  }
}

async function hasUserBanReasonColumn() {
  if (hasUserBanReasonColumnCache !== null) return hasUserBanReasonColumnCache;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM users LIKE 'ban_reason'");
    hasUserBanReasonColumnCache = rows.length > 0;
    return hasUserBanReasonColumnCache;
  } catch (_) {
    hasUserBanReasonColumnCache = false;
    return false;
  }
}

async function hasBarSuspensionMessageColumn() {
  if (hasBarSuspensionMessageColumnCache !== null) return hasBarSuspensionMessageColumnCache;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM bars LIKE 'suspension_message'");
    hasBarSuspensionMessageColumnCache = rows.length > 0;
    return hasBarSuspensionMessageColumnCache;
  } catch (_) {
    hasBarSuspensionMessageColumnCache = false;
    return false;
  }
}

/**
 * Get effective permissions for a user.
 *
 * Resolution:
 *  1. If user_permissions has ANY rows → use only those (granted = 1).
 *  2. Otherwise → use role_permissions defaults.
 */
async function getEffectivePermissionCodes(userId) {
  // Check if per-user overrides exist
  const [overrideCheck] = await pool.query(
    "SELECT 1 FROM user_permissions WHERE user_id = ? LIMIT 1",
    [userId]
  );

  if (overrideCheck.length > 0) {
    // User has custom permissions — only return granted ones
    const [rows] = await pool.query(
      `SELECT DISTINCT p.name
       FROM user_permissions up
       JOIN permissions p ON p.id = up.permission_id
       WHERE up.user_id = ? AND up.granted = 1
       ORDER BY p.name`,
      [userId]
    );
    return rows.map((x) => x.name);
  }

  // Fall back to role defaults — join via role_id or fall back to role name
  const [rows] = await pool.query(
    `SELECT DISTINCT p.name
     FROM users u
     JOIN roles r ON r.id = COALESCE(u.role_id, (SELECT id FROM roles WHERE UPPER(name) = UPPER(u.role) LIMIT 1))
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE u.id = ?
     ORDER BY p.name`,
    [userId]
  );
  return rows.map((x) => x.name);
}

async function getMaintenanceState() {
  const now = Date.now();
  if (maintenanceStateCache.expiresAt > now) {
    return {
      maintenanceMode: maintenanceStateCache.maintenanceMode,
      maintenanceMessage: maintenanceStateCache.maintenanceMessage,
    };
  }

  try {
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value
       FROM platform_settings
       WHERE setting_key IN ('maintenance_mode', 'maintenance_message')`
    );
    const settingsMap = rows.reduce((acc, row) => {
      acc[row.setting_key] = row.setting_value;
      return acc;
    }, {});
    maintenanceStateCache = {
      expiresAt: now + 15000,
      maintenanceMode: Number(settingsMap.maintenance_mode || 0) === 1,
      maintenanceMessage: String(settingsMap.maintenance_message || "").trim(),
    };
  } catch (_) {
    maintenanceStateCache = {
      expiresAt: now + 15000,
      maintenanceMode: false,
      maintenanceMessage: "",
    };
  }

  return {
    maintenanceMode: maintenanceStateCache.maintenanceMode,
    maintenanceMessage: maintenanceStateCache.maintenanceMessage,
  };
}

// Utility function
function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      email: user.email,
      bar_id: user.bar_id
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// Get current user profile
router.get("/me", require("../middlewares/requireAuth"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.is_active, u.is_verified,
              u.bar_id, u.phone_number, u.date_of_birth, u.profile_picture,
              b.name AS bar_name,
              bo.id AS bar_owner_id
       FROM users u
       LEFT JOIN bars b ON b.id = u.bar_id
       LEFT JOIN bar_owners bo ON bo.user_id = u.id
       WHERE u.id = ? LIMIT 1`,
      [req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = rows[0];
    user.profile_url = safeProfileUrl(user.profile_picture);

    res.json({
      success: true,
      data: user,
    });
  } catch (err) {
    console.error("GET /me ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get current user permissions
router.get("/me/permissions", require("../middlewares/requireAuth"), async (req, res) => {
  try {
    const userId = req.user.id;

    const [userRows] = await pool.query(
      `SELECT u.id, u.email, u.role, u.role_id, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? LIMIT 1`,
      [userId]
    );

    const permissionCodes = await getEffectivePermissionCodes(userId);
    
    res.json({
      success: true,
      user: userRows[0] || null,
      permissions: permissionCodes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Register new customer user
router.get("/platform/maintenance", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value, updated_at
       FROM platform_settings
       WHERE setting_key IN ('maintenance_mode', 'maintenance_message')`
    );

    const settingsMap = rows.reduce((acc, row) => {
      acc[row.setting_key] = row.setting_value;
      return acc;
    }, {});

    const updatedAt = rows.reduce((latest, row) => {
      if (!latest || (row.updated_at && row.updated_at > latest)) return row.updated_at;
      return latest;
    }, null);

    return res.json({
      success: true,
      data: {
        maintenance_mode: Number(settingsMap.maintenance_mode || 0),
        maintenance_message: settingsMap.maintenance_message || null,
        updated_at: updatedAt,
      },
    });
  } catch (_) {
    return res.json({
      success: true,
      data: { maintenance_mode: 0, maintenance_message: null, updated_at: null },
    });
  }
});

router.get("/platform/announcements", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const [rows] = await pool.query(
      `SELECT id, title, message, is_active, starts_at, ends_at, created_at, updated_at
       FROM platform_announcements
       WHERE is_active = 1
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at IS NULL OR ends_at >= NOW())
       ORDER BY id DESC
       LIMIT ${limit}`
    );
    return res.json({ success: true, data: rows });
  } catch (_) {
    return res.json({ success: true, data: [] });
  }
});

// Login user
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    if (String(email).length > 255 || String(password).length > 128) {
      return res.status(400).json({ success: false, message: "Invalid credentials" });
    }

    // Find user by email with bar_id + bar name
    const [rows] = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.password, u.role,
              u.role_id, r.name AS role_name,
              u.is_active, u.is_verified, u.bar_id, u.phone_number, u.date_of_birth,
              u.profile_picture, b.name AS bar_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN bars b ON b.id = u.bar_id
       WHERE u.email = ? LIMIT 1`,
      [email]
    );

    if (!rows.length) {
      // Check if email has a pending business registration
      try {
        const [pendingRegs] = await pool.query(
          "SELECT id, status FROM business_registrations WHERE owner_email = ? ORDER BY id DESC LIMIT 1",
          [String(email).trim().toLowerCase()]
        );
        if (pendingRegs.length) {
          const reg = pendingRegs[0];
          if (reg.status === 'pending') {
            return res.status(403).json({
              success: false,
              code: "REGISTRATION_PENDING",
              message: "Your business registration is currently under review. Please wait for approval before logging in.",
            });
          }
          if (reg.status === 'rejected') {
            return res.status(403).json({
              success: false,
              code: "REGISTRATION_REJECTED",
              message: "Your business registration was not approved. Please contact support for more information.",
            });
          }
        }
      } catch (_) { /* table may not exist yet */ }

      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const user = rows[0];

    // Check if account is active
    if (user.is_active === 0) {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_DEACTIVATED",
        message: "Your account has been deactivated. Please contact your administrator.",
      });
    }

    // Block unverified customer accounts
    if (user.role === 'customer' && !user.is_verified) {
      return res.status(403).json({
        success: false,
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email before logging in. Check your inbox for the confirmation link.",
        email: user.email
      });
    }

    // Detect Google-only accounts (password stored as empty string)
    if (!user.password) {
      return res.status(401).json({
        success: false,
        code: "GOOGLE_ACCOUNT",
        message: "This account uses Google sign-in. Please use the 'Continue with Google' button to log in.",
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // ROLE RESTRICTION by portal
    // - Default behavior remains Bar Management login restrictions
    // - Customer website sends x-login-portal: customer to allow customer accounts
    const roleName = String(user.role_name || user.role || "").toUpperCase();
    const loginPortal = String(req.headers["x-login-portal"] || req.body?.portal || "bar_management").toLowerCase();

    if (loginPortal === "customer") {
      if (roleName !== "CUSTOMER") {
        return res.status(403).json({
          success: false,
          code: "ROLE_NOT_ALLOWED",
          message: "This account cannot access the Customer Website.",
        });
      }
    } else {
      const allowedRoles = ["BAR_OWNER", "MANAGER", "STAFF", "EMPLOYEE", "SUPER_ADMIN"];
      if (!allowedRoles.includes(roleName)) {
        return res.status(403).json({
          success: false,
          code: "ROLE_NOT_ALLOWED",
          message: "This account cannot access the Bar Management system. Please use the customer app instead.",
        });
      }
    }

    // Maintenance mode: only SUPER_ADMIN can continue
    if (roleName !== "SUPER_ADMIN") {
      const { maintenanceMode, maintenanceMessage } = await getMaintenanceState();
      if (maintenanceMode) {
        return res.status(503).json({
          success: false,
          code: "MAINTENANCE_MODE",
          message:
            maintenanceMessage ||
            "Platform is currently under maintenance. Please try again later.",
        });
      }
    }

    // Global platform ban check (SUPER_ADMIN bans)
    if (await hasGlobalBanColumn()) {
      const [[banRow]] = await pool.query(
        "SELECT COALESCE(is_banned, 0) AS is_banned FROM users WHERE id = ? LIMIT 1",
        [user.id]
      );

      if (Number(banRow?.is_banned || 0) === 1) {
        let banMessage = "Your account has been banned from the platform.";
        if (await hasUserBanReasonColumn()) {
          const [[banReasonRow]] = await pool.query(
            "SELECT ban_reason FROM users WHERE id = ? LIMIT 1",
            [user.id]
          );
          const reason = String(banReasonRow?.ban_reason || "").trim();
          if (reason) banMessage = reason;
        }

        return res.status(403).json({
          success: false,
          code: "ACCOUNT_BANNED",
          message: banMessage,
        });
      }
    }

    // Bar suspension check: block bar-side roles when assigned bar is inactive/suspended
    if (roleName !== "SUPER_ADMIN" && roleName !== "CUSTOMER" && user.bar_id) {
      const hasSuspensionMessage = await hasBarSuspensionMessageColumn();
      const [barRows] = await pool.query(
        `SELECT status, lifecycle_status${hasSuspensionMessage ? ", suspension_message" : ", NULL AS suspension_message"}
         FROM bars
         WHERE id = ?
         LIMIT 1`,
        [user.bar_id]
      );
      const barState = barRows[0];
      if (barState) {
        const status = String(barState.status || "").toLowerCase();
        const lifecycle = String(barState.lifecycle_status || "").toLowerCase();
        const isSuspended =
          status === "inactive" ||
          lifecycle === "suspended";
        if (isSuspended) {
          return res.status(403).json({
            success: false,
            code: "BAR_SUSPENDED",
            message:
              String(barState.suspension_message || "").trim() ||
              "Your bar account is currently suspended. Please contact support.",
          });
        }
      }
    }

    // Generate token
    const token = signToken(user);

    // Effective permissions at login
    const permissionCodes = await getEffectivePermissionCodes(user.id);

    // Non-blocking audit log for successful login
    if (user.bar_id) {
      logAudit(null, {
        bar_id: user.bar_id,
        user_id: user.id,
        action: "LOGIN",
        entity: "user",
        entity_id: user.id,
        details: { email: user.email, role: user.role },
        ...auditContext(req)
      });
    }

    return res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          first_name: user.first_name,
          last_name: user.last_name,
          email: user.email,
          role: user.role,
          bar_id: user.bar_id,
          bar_name: user.bar_name || null,
          phone_number: user.phone_number,
          date_of_birth: user.date_of_birth,
          profile_picture: user.profile_picture,
          profile_url: safeProfileUrl(user.profile_picture),
          is_active: user.is_active
        },
        permissions: permissionCodes
      }
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err.message);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// CUSTOMER REGISTER (sets role_id too)
router.post("/register", async (req, res) => {
  try {
    const { first_name, last_name, email, password, phone_number, date_of_birth } = req.body || {};

    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "first_name, last_name, email, password are required"
      });
    }

    if (String(first_name).length > 100 || String(last_name).length > 100) {
      return res.status(400).json({ success: false, message: "Name must be 100 characters or less" });
    }
    if (String(email).length > 255) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }
    if (String(password).length > 128) {
      return res.status(400).json({ success: false, message: "Password must be 128 characters or less" });
    }
    if (phone_number && String(phone_number).length > 20) {
      return res.status(400).json({ success: false, message: "Invalid phone number" });
    }

    const emailNorm = String(email).trim().toLowerCase();

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm);
    if (!emailOk) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    // Ensure CUSTOMER role exists and get role_id
    const [roleRows] = await pool.query(
      "SELECT id FROM roles WHERE name IN ('CUSTOMER','customer') LIMIT 1"
    );
    if (!roleRows.length) {
      return res.status(500).json({
        success: false,
        message: "CUSTOMER role not found in roles table"
      });
    }
    const customerRoleId = roleRows[0].id;

    // Check existing email
    const [exists] = await pool.query(
      "SELECT id FROM users WHERE email=? LIMIT 1",
      [emailNorm]
    );
    if (exists.length) {
      return res.status(409).json({ success: false, message: "Email already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    // Generate email verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create user as CUSTOMER (bar_id NULL) + role_id set + default avatar
    const [result] = await pool.query(
      `INSERT INTO users
       (first_name, last_name, email, password, phone_number, date_of_birth, role, role_id, is_verified, is_active, bar_id,
        profile_picture, email_verification_token, email_verification_expires, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'customer', ?, 0, 1, NULL, ?, ?, ?, NOW(), NOW())`,
      [first_name, last_name, emailNorm, hashed, phone_number || null, date_of_birth || null, customerRoleId,
       DEFAULT_AVATAR, verificationToken, tokenExpires]
    );

    // Send verification email (non-blocking — don't fail registration if email fails)
    try {
      await sendVerificationEmail(emailNorm, first_name, verificationToken);
      console.log('Verification email sent to:', emailNorm);
    } catch (emailErr) {
      console.error('VERIFICATION EMAIL ERROR (full):', emailErr);
    }

    return res.status(201).json({
      success: true,
      message: "Customer registered. Please check your email to verify your account.",
      data: {
        user_id: result.insertId,
        email: emailNorm,
        role: "customer",
        role_id: customerRoleId,
        is_verified: 0
      }
    });
  } catch (err) {
    console.error("CUSTOMER REGISTER ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.sqlMessage || err.message || "Server error"
    });
  }
});



// ─── VERIFY EMAIL ───
router.get("/verify-email", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: "Token is required" });

    const [rows] = await pool.query(
      "SELECT id, email_verification_expires, is_verified FROM users WHERE email_verification_token = ? LIMIT 1",
      [token]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Invalid or already used verification link." });
    }

    const user = rows[0];

    if (user.is_verified) {
      return res.json({ success: true, message: "Email already verified. You can log in." });
    }

    if (new Date() > new Date(user.email_verification_expires)) {
      return res.status(410).json({ success: false, message: "Verification link has expired. Please request a new one." });
    }

    await pool.query(
      "UPDATE users SET is_verified = 1, email_verification_token = NULL, email_verification_expires = NULL WHERE id = ?",
      [user.id]
    );

    return res.json({ success: true, message: "Email verified successfully! You can now log in." });
  } catch (err) {
    console.error("VERIFY EMAIL ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── RESEND VERIFICATION EMAIL (rate-limited: 60s cooldown) ───
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const emailNorm = String(email).trim().toLowerCase();
    const [rows] = await pool.query(
      "SELECT id, first_name, is_verified, email_verification_expires FROM users WHERE email = ? LIMIT 1",
      [emailNorm]
    );

    if (!rows.length) return res.status(404).json({ success: false, message: "Email not found" });
    if (rows[0].is_verified) return res.json({ success: true, message: "Email already verified." });

    // Rate limit: token was issued at (expires - 24h). Block if issued < 60s ago.
    if (rows[0].email_verification_expires) {
      const issuedAt = new Date(rows[0].email_verification_expires).getTime() - (24 * 60 * 60 * 1000);
      const secondsSinceIssued = Math.floor((Date.now() - issuedAt) / 1000);
      const COOLDOWN_SECONDS = 60;
      if (secondsSinceIssued < COOLDOWN_SECONDS) {
        const waitSeconds = COOLDOWN_SECONDS - secondsSinceIssued;
        return res.status(429).json({
          success: false,
          code: "RESEND_COOLDOWN",
          message: `Please wait ${waitSeconds} second${waitSeconds !== 1 ? 's' : ''} before requesting another email.`,
          wait_seconds: waitSeconds
        });
      }
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      "UPDATE users SET email_verification_token = ?, email_verification_expires = ? WHERE id = ?",
      [verificationToken, tokenExpires, rows[0].id]
    );

    await sendVerificationEmail(emailNorm, rows[0].first_name, verificationToken);

    return res.json({ success: true, message: "Verification email sent! Check your inbox." });
  } catch (err) {
    console.error("RESEND VERIFICATION ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── UPDATE PROFILE (all roles) ───
router.patch("/me/profile", require("../middlewares/requireAuth"), async (req, res) => {
  try {
    const userId = req.user.id;
    const { first_name, last_name, phone_number, date_of_birth, email } = req.body || {};

    // Only allow safe fields
    const updates = [];
    const params = [];

    if (first_name !== undefined) { updates.push("first_name = ?"); params.push(String(first_name).trim()); }
    if (last_name !== undefined) { updates.push("last_name = ?"); params.push(String(last_name).trim()); }
    if (phone_number !== undefined) { updates.push("phone_number = ?"); params.push(phone_number ? String(phone_number).trim() : null); }
    if (date_of_birth !== undefined) { updates.push("date_of_birth = ?"); params.push(date_of_birth || null); }
    if (email !== undefined) {
      const emailNorm = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
        return res.status(400).json({ success: false, message: "Invalid email format" });
      }
      // Check if email is taken by another user
      const [dup] = await pool.query("SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1", [emailNorm, userId]);
      if (dup.length) {
        return res.status(409).json({ success: false, message: "Email already in use by another account" });
      }
      updates.push("email = ?"); params.push(emailNorm);
    }

    if (!updates.length) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    updates.push("updated_at = NOW()");
    params.push(userId);

    await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    // Return updated user (with bar_name + profile_url)
    const [rows] = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.is_active, u.is_verified,
              u.bar_id, u.phone_number, u.date_of_birth, u.profile_picture,
              b.name AS bar_name
       FROM users u
       LEFT JOIN bars b ON b.id = u.bar_id
       WHERE u.id = ? LIMIT 1`,
      [userId]
    );

    const updated = rows[0];
    if (updated) updated.profile_url = safeProfileUrl(updated.profile_picture);

    return res.json({ success: true, message: "Profile updated", data: updated });
  } catch (err) {
    console.error("UPDATE PROFILE ERROR:", err);
    return res.status(500).json({ success: false, message: err.sqlMessage || "Server error" });
  }
});

// ─── CHANGE PASSWORD (all roles) ───
router.post("/me/change-password", require("../middlewares/requireAuth"), async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_password, new_password } = req.body || {};

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: "current_password and new_password required" });
    }

    if (String(new_password).length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters" });
    }
    if (String(current_password).length > 128 || String(new_password).length > 128) {
      return res.status(400).json({ success: false, message: "Password must be 128 characters or less" });
    }

    // Verify current password
    const [rows] = await pool.query("SELECT password FROM users WHERE id = ? LIMIT 1", [userId]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isValid = await bcrypt.compare(current_password, rows[0].password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?", [hashed, userId]);

    return res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE PASSWORD ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GOOGLE OAUTH ───
const { OAuth2Client } = require("google-auth-library");

function getGoogleClient() {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
}

function calculateAgeFromDob(dob) {
  if (!dob) return null;
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// POST /auth/google — verify credential, return JWT if existing user or profile info if new
router.post("/google", async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ success: false, message: "Google credential is required" });
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ success: false, message: "Google OAuth not configured on server" });

    const client = getGoogleClient();
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (e) {
      return res.status(401).json({ success: false, message: "Invalid Google credential. Please try again." });
    }

    const emailNorm = String(payload.email || "").trim().toLowerCase();
    if (!emailNorm) return res.status(400).json({ success: false, message: "Google account has no email." });

    // Check maintenance mode
    const { maintenanceMode, maintenanceMessage } = await getMaintenanceState();
    if (maintenanceMode) {
      return res.status(503).json({ success: false, code: "MAINTENANCE_MODE", message: maintenanceMessage || "Platform is under maintenance." });
    }

    // Check if user already exists
    const [rows] = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.role_id, r.name AS role_name,
              u.is_active, u.is_verified, u.bar_id, u.phone_number, u.date_of_birth,
              u.profile_picture, b.name AS bar_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN bars b ON b.id = u.bar_id
       WHERE u.email = ? LIMIT 1`,
      [emailNorm]
    );

    if (rows.length) {
      const user = rows[0];

      if (user.is_active === 0) {
        return res.status(403).json({ success: false, code: "ACCOUNT_DEACTIVATED", message: "Your account has been deactivated." });
      }

      // Only allow customer role via Google login on this portal
      const roleName = String(user.role_name || user.role || "").toUpperCase();
      if (roleName !== "CUSTOMER") {
        return res.status(403).json({ success: false, code: "ROLE_NOT_ALLOWED", message: "This account cannot access the Customer Website." });
      }

      // Auto-verify email if not yet verified (Google accounts are pre-verified)
      if (!user.is_verified) {
        await pool.query("UPDATE users SET is_verified = 1, updated_at = NOW() WHERE id = ?", [user.id]);
      }

      // Update profile picture from Google if user has default/no picture
      if (payload.picture && (!user.profile_picture || user.profile_picture === DEFAULT_AVATAR)) {
        await pool.query("UPDATE users SET profile_picture = ?, updated_at = NOW() WHERE id = ?", [payload.picture, user.id]);
      }

      const token = signToken(user);
      const permissionCodes = await getEffectivePermissionCodes(user.id);

      return res.json({
        success: true,
        new_user: false,
        data: {
          token,
          user: {
            id: user.id,
            first_name: user.first_name,
            last_name: user.last_name,
            email: user.email,
            role: user.role,
            bar_id: user.bar_id,
            bar_name: user.bar_name || null,
            phone_number: user.phone_number,
            date_of_birth: user.date_of_birth,
            profile_picture: payload.picture || user.profile_picture,
            profile_url: payload.picture || safeProfileUrl(user.profile_picture),
            is_active: user.is_active
          },
          permissions: permissionCodes
        }
      });
    }

    // New user — return Google profile for age verification step
    return res.json({
      success: true,
      new_user: true,
      google_profile: {
        email: emailNorm,
        first_name: payload.given_name || payload.name?.split(' ')[0] || '',
        last_name: payload.family_name || payload.name?.split(' ').slice(1).join(' ') || '',
        picture: payload.picture || null,
        credential
      }
    });
  } catch (err) {
    console.error("GOOGLE AUTH ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /auth/google/complete — create new user after age verification
router.post("/google/complete", async (req, res) => {
  try {
    const { credential, date_of_birth } = req.body || {};
    if (!credential) return res.status(400).json({ success: false, message: "Google credential is required" });
    if (!date_of_birth) return res.status(400).json({ success: false, message: "Date of birth is required" });

    // Verify age
    const age = calculateAgeFromDob(date_of_birth);
    if (age === null || age < 18) {
      return res.status(403).json({
        success: false,
        code: "UNDERAGE",
        message: `You must be at least 18 years old to register. (You are ${age ?? 'unknown'} years old)`
      });
    }

    // Re-verify Google credential
    const client = getGoogleClient();
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (e) {
      return res.status(401).json({ success: false, message: "Google session expired. Please try again." });
    }

    const emailNorm = String(payload.email || "").trim().toLowerCase();
    if (!emailNorm) return res.status(400).json({ success: false, message: "Google account has no email." });

    // Check again in case user registered while filling form
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [emailNorm]);
    if (existing.length) {
      return res.status(409).json({ success: false, message: "An account with this email already exists. Please log in." });
    }

    const [roleRows] = await pool.query("SELECT id FROM roles WHERE name IN ('CUSTOMER','customer') LIMIT 1");
    if (!roleRows.length) return res.status(500).json({ success: false, message: "CUSTOMER role not found" });
    const customerRoleId = roleRows[0].id;

    const firstName = payload.given_name || payload.name?.split(' ')[0] || '';
    const lastName = payload.family_name || payload.name?.split(' ').slice(1).join(' ') || '';
    const picture = payload.picture || DEFAULT_AVATAR;

    const [result] = await pool.query(
      `INSERT INTO users
       (first_name, last_name, email, password, phone_number, date_of_birth, role, role_id,
        is_verified, is_active, bar_id, profile_picture, created_at, updated_at)
       VALUES (?, ?, ?, '', NULL, ?, 'customer', ?, 1, 1, NULL, ?, NOW(), NOW())`,
      [firstName, lastName, emailNorm, date_of_birth, customerRoleId, picture]
    );

    const [newUserRows] = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.role_id, r.name AS role_name,
              u.is_active, u.is_verified, u.bar_id, u.phone_number, u.date_of_birth, u.profile_picture
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? LIMIT 1`,
      [result.insertId]
    );

    const user = newUserRows[0];
    const token = signToken(user);
    const permissionCodes = await getEffectivePermissionCodes(user.id);

    return res.json({
      success: true,
      new_user: false,
      data: {
        token,
        user: {
          id: user.id,
          first_name: user.first_name,
          last_name: user.last_name,
          email: user.email,
          role: user.role,
          bar_id: null,
          bar_name: null,
          phone_number: null,
          date_of_birth: user.date_of_birth,
          profile_picture: picture,
          profile_url: picture,
          is_active: 1
        },
        permissions: permissionCodes
      }
    });
  } catch (err) {
    console.error("GOOGLE COMPLETE ERROR:", err);
    return res.status(500).json({ success: false, message: err.sqlMessage || "Server error" });
  }
});

// ─── FORGOT PASSWORD ───
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const emailNorm = String(email).trim().toLowerCase();
    const [rows] = await pool.query(
      "SELECT id, first_name, role FROM users WHERE email = ? AND is_active = 1 LIMIT 1",
      [emailNorm]
    );

    // Always return success to avoid email enumeration
    if (!rows.length) {
      return res.json({ success: true, message: "If an account exists with that email, a reset link has been sent." });
    }

    const user = rows[0];

    // Ensure password_reset_token columns exist
    try {
      const [cols] = await pool.query("SHOW COLUMNS FROM users LIKE 'password_reset_token'");
      if (!cols.length) {
        await pool.query(
          "ALTER TABLE users ADD COLUMN password_reset_token VARCHAR(255) DEFAULT NULL, ADD COLUMN password_reset_expires DATETIME DEFAULT NULL"
        );
      }
    } catch (_) {}

    // Rate limit: block if a token was issued < 60s ago
    try {
      const [tokenRow] = await pool.query(
        "SELECT password_reset_expires FROM users WHERE id = ? LIMIT 1",
        [user.id]
      );
      if (tokenRow[0]?.password_reset_expires) {
        const issuedAt = new Date(tokenRow[0].password_reset_expires).getTime() - (60 * 60 * 1000);
        const secondsSince = Math.floor((Date.now() - issuedAt) / 1000);
        if (secondsSince < 60) {
          const wait = 60 - secondsSince;
          return res.status(429).json({
            success: false,
            code: "RESET_COOLDOWN",
            message: `Please wait ${wait} second${wait !== 1 ? 's' : ''} before requesting another reset.`,
            wait_seconds: wait
          });
        }
      }
    } catch (_) {}

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      "UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?",
      [resetToken, tokenExpires, user.id]
    );

    try {
      await sendPasswordResetEmail(emailNorm, user.first_name, resetToken);
    } catch (emailErr) {
      console.error("PASSWORD RESET EMAIL ERROR:", emailErr);
    }

    return res.json({ success: true, message: "If an account exists with that email, a reset link has been sent." });
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── RESET PASSWORD ───
router.post("/reset-password", async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    if (!token || !new_password) {
      return res.status(400).json({ success: false, message: "Token and new_password are required" });
    }
    if (String(new_password).length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    const [rows] = await pool.query(
      "SELECT id, password_reset_expires FROM users WHERE password_reset_token = ? LIMIT 1",
      [token]
    );

    if (!rows.length) {
      return res.status(400).json({ success: false, message: "Invalid or expired reset link. Please request a new one." });
    }

    const user = rows[0];
    if (new Date() > new Date(user.password_reset_expires)) {
      return res.status(410).json({ success: false, message: "This reset link has expired. Please request a new one." });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(
      "UPDATE users SET password = ?, password_reset_token = NULL, password_reset_expires = NULL, updated_at = NOW() WHERE id = ?",
      [hashed, user.id]
    );

    return res.json({ success: true, message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── UPLOAD PROFILE PICTURE (all roles) ───
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/profiles";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `user_${req.user.id}_${Date.now()}${ext}`);
  }
});
const profileUpload = multer({ storage: profileStorage, limits: { fileSize: 5 * 1024 * 1024 } });

const regDocsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/registration_docs";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `reg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const regDocsUpload = multer({ storage: regDocsStorage, limits: { fileSize: 10 * 1024 * 1024 } });

router.post("/me/profile-picture", require("../middlewares/requireAuth"), profileUpload.single("profile_picture"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    // Delete old profile picture file if it exists
    const [oldRows] = await pool.query(
      "SELECT profile_picture FROM users WHERE id = ? LIMIT 1",
      [req.user.id]
    );
    if (oldRows.length && oldRows[0].profile_picture) {
      const oldPath = path.resolve(oldRows[0].profile_picture);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (_) {}
      }
    }

    const filePath = req.file.path.replace(/\\/g, "/");
    await pool.query("UPDATE users SET profile_picture = ?, updated_at = NOW() WHERE id = ?", [filePath, req.user.id]);

    return res.json({ success: true, message: "Profile picture updated", data: { profile_picture: filePath, profile_url: safeProfileUrl(filePath) } });
  } catch (err) {
    console.error("PROFILE PICTURE ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── BAR OWNER REGISTRATION (multi-step form, named doc uploads) ───
const barOwnerDocsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/registration_docs";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const fieldSafe = file.fieldname.replace(/[^a-z0-9]/gi, "_");
    cb(null, `${fieldSafe}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const barOwnerUpload = multer({
  storage: barOwnerDocsStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error("Only JPG, PNG, and PDF files are allowed"));
  }
});

router.post(
  "/register-bar-owner",
  barOwnerUpload.fields([
    { name: "bir_certificate", maxCount: 1 },
    { name: "business_permit", maxCount: 1 },
    { name: "selfie_with_id", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const {
        // Step 1 — Owner Account
        first_name, middle_name, last_name, email, password, phone_number,
        // Step 2 — Bar Details
        bar_name, bar_address, bar_city, bar_barangay, bar_types, bar_description,
        opening_time, closing_time, gcash_number, gcash_name
      } = req.body || {};

      // --- Validation ---
      if (!first_name || !last_name || !email || !password) {
        return res.status(400).json({ success: false, message: "Owner first name, last name, email, and password are required" });
      }
      if (!bar_name || !bar_address || !bar_city) {
        return res.status(400).json({ success: false, message: "Bar name, address, and city are required" });
      }
      const emailNorm = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
        return res.status(400).json({ success: false, message: "Invalid email format" });
      }
      if (String(password).length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      }

      // Require both documents
      const birFile = req.files?.bir_certificate?.[0];
      const permitFile = req.files?.business_permit?.[0];
      const selfieFile = req.files?.selfie_with_id?.[0];
      if (!birFile) {
        return res.status(400).json({ success: false, message: "BIR Certificate is required" });
      }
      if (!permitFile) {
        return res.status(400).json({ success: false, message: "Business Permit is required" });
      }
      if (!selfieFile) {
        return res.status(400).json({ success: false, message: "Photo holding your ID is required" });
      }
      const selfieExt = path.extname(selfieFile.originalname).toLowerCase();
      if (![".jpg", ".jpeg", ".png"].includes(selfieExt)) {
        return res.status(400).json({ success: false, message: "Photo holding your ID must be a JPG or PNG image" });
      }

      // Check duplicate email in users
      const [existingUser] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [emailNorm]);
      if (existingUser.length) {
        return res.status(409).json({ success: false, message: "This email is already registered. Please log in instead." });
      }

      // Check duplicate pending registration
      const [existingReg] = await pool.query(
        "SELECT id FROM business_registrations WHERE owner_email = ? AND status IN ('pending','pending_email_verification','pending_admin_approval') LIMIT 1",
        [emailNorm]
      );
      if (existingReg.length) {
        return res.status(409).json({ success: false, message: "A registration with this email is already pending review." });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const birPath = birFile.path.replace(/\\/g, "/");
      const permitPath = permitFile.path.replace(/\\/g, "/");
      const selfiePath = selfieFile.path.replace(/\\/g, "/");

      const verificationToken = crypto.randomBytes(32).toString("hex");
      const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      let barTypesJson = null;
      if (bar_types) {
        try {
          const parsed = JSON.parse(bar_types);
          if (Array.isArray(parsed)) barTypesJson = JSON.stringify(parsed);
        } catch (_) {
          barTypesJson = null;
        }
      }
      const fullAddress = bar_barangay ? `${bar_address}, ${bar_barangay}` : bar_address;

      const [result] = await pool.query(
        `INSERT INTO business_registrations
         (business_name, business_address, business_city, business_state, business_phone, business_barangay, bar_types,
          business_description, opening_time, closing_time, gcash_number, gcash_name,
          owner_first_name, owner_middle_name, owner_last_name, owner_email, owner_phone, owner_password,
          email_verification_token, email_verification_expires,
          bir_certificate, business_permit, selfie_with_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_email_verification', NOW(), NOW())`,
        [
          bar_name, fullAddress, bar_city, "Cavite", phone_number || null, bar_barangay || null, barTypesJson,
          bar_description || null, opening_time || null, closing_time || null,
          gcash_number || null, gcash_name || null,
          first_name, middle_name || null, last_name, emailNorm, phone_number || null, hashedPassword,
          verificationToken, tokenExpires,
          birPath, permitPath, selfiePath
        ]
      );

      try {
        await sendBarOwnerVerificationEmail(emailNorm, first_name, verificationToken);
      } catch (emailErr) {
        console.error("BAR OWNER VERIFICATION EMAIL ERROR:", emailErr);
      }

      return res.status(201).json({
        success: true,
        message: "Registration submitted. Please check your email to verify your address before admin review.",
        data: { registration_id: result.insertId }
      });
    } catch (err) {
      console.error("BAR OWNER REGISTER ERROR:", err);
      return res.status(500).json({ success: false, message: err.sqlMessage || err.message || "Server error" });
    }
  }
);

router.get("/verify-bar-owner-email", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: "Token is required" });

    const [rows] = await pool.query(
      "SELECT id, email_verification_expires, email_verified_at, status FROM business_registrations WHERE email_verification_token = ? LIMIT 1",
      [token]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Invalid or already used verification link." });
    }

    const reg = rows[0];
    if (reg.email_verified_at) {
      return res.json({
        success: true,
        message: "Email already verified. Your account is under review. You will be notified once approved."
      });
    }

    if (reg.email_verification_expires && new Date() > new Date(reg.email_verification_expires)) {
      return res.status(410).json({ success: false, message: "Verification link has expired. Please register again." });
    }

    await pool.query(
      "UPDATE business_registrations SET email_verified_at = NOW(), email_verification_token = NULL, email_verification_expires = NULL, status = 'pending_admin_approval' WHERE id = ?",
      [reg.id]
    );

    return res.json({
      success: true,
      message: "Your account is under review. You will be notified once approved."
    });
  } catch (err) {
    console.error("VERIFY BAR OWNER EMAIL ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── JOIN TPG: Business Registration (public, with doc uploads) ───
router.post("/register-business", regDocsUpload.array("supporting_docs", 5), async (req, res) => {
  try {
    const {
      business_name, business_address, business_city, business_state,
      business_zip, business_phone, business_email, business_category,
      owner_first_name, owner_last_name, owner_email, owner_phone, owner_password
    } = req.body || {};

    // Validate required fields
    if (!business_name || !business_address || !business_city || !business_phone) {
      return res.status(400).json({ success: false, message: "Business name, address, city, and phone are required" });
    }
    if (!owner_first_name || !owner_last_name || !owner_email || !owner_phone || !owner_password) {
      return res.status(400).json({ success: false, message: "Owner first name, last name, email, phone, and password are required" });
    }

    const emailNorm = String(owner_email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }
    if (String(owner_password).length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    // Check if email already exists in users OR pending registrations
    const [existingUser] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [emailNorm]);
    if (existingUser.length) {
      return res.status(409).json({ success: false, message: "This email is already registered. Please login instead." });
    }

    const [existingReg] = await pool.query(
      "SELECT id FROM business_registrations WHERE owner_email = ? AND status = 'pending' LIMIT 1",
      [emailNorm]
    );
    if (existingReg.length) {
      return res.status(409).json({ success: false, message: "A registration with this email is already pending review." });
    }

    const hashedPassword = await bcrypt.hash(owner_password, 10);

    // Collect uploaded document paths
    const docPaths = (req.files || []).map(f => f.path.replace(/\\/g, "/"));
    const docsJson = docPaths.length ? JSON.stringify(docPaths) : null;

    const [result] = await pool.query(
      `INSERT INTO business_registrations
       (business_name, business_address, business_city, business_state, business_zip,
        business_phone, business_email, business_category,
        owner_first_name, owner_last_name, owner_email, owner_phone, owner_password, supporting_docs, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        business_name, business_address, business_city, business_state || null,
        business_zip || null, business_phone, business_email || null, business_category || null,
        owner_first_name, owner_last_name, emailNorm, owner_phone, hashedPassword, docsJson
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Your registration has been submitted and is pending approval.",
      data: { registration_id: result.insertId, documents_uploaded: docPaths.length }
    });
  } catch (err) {
    console.error("REGISTER BUSINESS ERROR:", err);
    return res.status(500).json({ success: false, message: err.sqlMessage || "Server error" });
  }
});

module.exports = router;
