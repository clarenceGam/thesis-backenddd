let maintenanceCache = {
  expiresAt: 0,
  maintenanceMode: false,
  maintenanceMessage: "",
};

async function getMaintenanceState(pool) {
  const now = Date.now();
  if (maintenanceCache.expiresAt > now) {
    return {
      maintenanceMode: maintenanceCache.maintenanceMode,
      maintenanceMessage: maintenanceCache.maintenanceMessage,
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
    maintenanceCache = {
      expiresAt: now + 15000,
      maintenanceMode: Number(settingsMap.maintenance_mode || 0) === 1,
      maintenanceMessage: String(settingsMap.maintenance_message || "").trim(),
    };
  } catch (_) {
    // Keep the app operational even if platform_settings does not exist yet.
    maintenanceCache = {
      expiresAt: now + 15000,
      maintenanceMode: false,
      maintenanceMessage: "",
    };
  }

  return {
    maintenanceMode: maintenanceCache.maintenanceMode,
    maintenanceMessage: maintenanceCache.maintenanceMessage,
  };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Missing token",
    });
  }

  try {
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Fetch user with role info from database
    const pool = require("../config/database");
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.role, u.role_id, u.bar_id, u.is_active,
              r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id=?
       LIMIT 1`,
      [decoded.id]
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    // SECURITY: Block inactive/deactivated users from all API access
    if (!rows[0].is_active) {
      return res.status(403).json({
        success: false,
        message: "Account is deactivated. Contact your administrator.",
      });
    }

    const roleName = String(rows[0].role_name || rows[0].role || "").toUpperCase();
    
    // Check if user is globally banned (only for non-super-admins)
    if (roleName !== "SUPER_ADMIN") {
      // Check for global ban
      try {
        const [banCheck] = await pool.query(
          "SELECT is_banned, ban_reason FROM users WHERE id = ? LIMIT 1",
          [decoded.id]
        );
        if (banCheck.length && Number(banCheck[0].is_banned || 0) === 1) {
          const banReason = String(banCheck[0].ban_reason || "").trim();
          return res.status(403).json({
            success: false,
            code: "USER_BANNED",
            message: banReason || "Your account has been banned from the platform.",
          });
        }
      } catch (banErr) {
        // Column might not exist, continue
      }
      
      // Check maintenance mode
      const { maintenanceMode, maintenanceMessage } = await getMaintenanceState(pool);
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
    
    req.user = rows[0];

    // ── Multi-branch: allow bar owners to override bar_id via X-Bar-Id header ──
    const xBarId = req.headers["x-bar-id"];
    if (xBarId) {
      const requestedBarId = parseInt(xBarId, 10);
      const role = String(rows[0].role || rows[0].role_name || "").toLowerCase();

      if (role === "bar_owner" && Number.isFinite(requestedBarId)) {
        // Verify the owner actually owns this bar
        const [ownerRows] = await pool.query(
          "SELECT id FROM bar_owners WHERE user_id = ? LIMIT 1",
          [rows[0].id]
        );
        if (ownerRows.length) {
          const [barRows] = await pool.query(
            "SELECT id FROM bars WHERE id = ? AND owner_id = ? AND is_locked = 0 LIMIT 1",
            [requestedBarId, ownerRows[0].id]
          );
          if (barRows.length) {
            req.user.bar_id = requestedBarId;
          }
        }
      }
    }

    next();
  } catch (e) {
    return res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }
}

module.exports = requireAuth;
