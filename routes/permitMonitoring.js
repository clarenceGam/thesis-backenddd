const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const requireAuth = require('../middlewares/requireAuth');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin');
const { logAudit } = require('../utils/audit');
const { runPermitExpiryCheck } = require('../jobs/permitExpiryChecker');

/**
 * GET /permit-monitoring/expiring
 * Get all bars with expired or soon-to-expire permits
 */
router.get('/expiring', requireAuth, async (req, res) => {
  try {
    const { status, limit = 100, page = 1 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = `WHERE b.permit_expiry_date IS NOT NULL`;
    const params = [];

    if (status && ['valid', 'expiring_soon', 'expired'].includes(status)) {
      whereClause += ` AND b.permit_status = ?`;
      params.push(status);
    } else {
      // Default: show only expiring_soon and expired
      whereClause += ` AND b.permit_status IN ('expiring_soon', 'expired')`;
    }

    // Get total count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total
       FROM bars b
       ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get bars with permit info
    const [bars] = await pool.query(
      `SELECT 
        b.id,
        b.name,
        b.address,
        b.city,
        b.permit_expiry_date,
        b.permit_status,
        b.permit_expiry_notified_at,
        b.permit_expired_flagged_at,
        b.status as bar_status,
        u.id as owner_id,
        u.email as owner_email,
        u.first_name as owner_first_name,
        u.last_name as owner_last_name,
        DATEDIFF(b.permit_expiry_date, CURDATE()) as days_until_expiry,
        (SELECT COUNT(*) FROM permit_expiry_notifications 
         WHERE bar_id = b.id AND notification_type = '30_day_warning') as warning_count
       FROM bars b
       LEFT JOIN users u ON b.owner_user_id = u.id
       ${whereClause}
       ORDER BY b.permit_expiry_date ASC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    return res.json({
      success: true,
      data: {
        bars,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('GET /permit-monitoring/expiring error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /permit-monitoring/stats
 * Get permit expiry statistics
 */
router.get('/stats', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total_bars,
        SUM(CASE WHEN permit_status = 'valid' THEN 1 ELSE 0 END) as valid_permits,
        SUM(CASE WHEN permit_status = 'expiring_soon' THEN 1 ELSE 0 END) as expiring_soon,
        SUM(CASE WHEN permit_status = 'expired' THEN 1 ELSE 0 END) as expired_permits,
        SUM(CASE WHEN permit_expiry_date IS NULL THEN 1 ELSE 0 END) as no_expiry_date
      FROM bars
    `);

    const [recentNotifications] = await pool.query(`
      SELECT 
        notification_type,
        COUNT(*) as count
      FROM permit_expiry_notifications
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY notification_type
    `);

    return res.json({
      success: true,
      data: {
        overview: stats[0],
        recentNotifications
      }
    });
  } catch (err) {
    console.error('GET /permit-monitoring/stats error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /permit-monitoring/deactivate/:barId
 * Manually deactivate a bar due to expired permit
 */
router.post('/deactivate/:barId', requireAuth, requireSuperAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { barId } = req.params;
    const { reason } = req.body;

    await conn.beginTransaction();

    // Get bar info
    const [bars] = await conn.query(
      'SELECT id, name, status, permit_status FROM bars WHERE id = ?',
      [barId]
    );

    if (bars.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Bar not found' });
    }

    const bar = bars[0];

    // Update bar status to inactive
    await conn.query(
      `UPDATE bars 
       SET status = 'inactive'
       WHERE id = ?`,
      [barId]
    );

    // Log audit
    await logAudit(
      barId,
      req.user.id,
      'DEACTIVATE_BAR_EXPIRED_PERMIT',
      'bars',
      barId,
      {
        reason: reason || 'Expired business permit',
        permit_status: bar.permit_status,
        previous_status: bar.status
      }
    );

    await conn.commit();

    return res.json({
      success: true,
      message: `Bar "${bar.name}" has been deactivated due to expired permit`
    });
  } catch (err) {
    await conn.rollback();
    console.error('POST /permit-monitoring/deactivate error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

/**
 * POST /permit-monitoring/reactivate/:barId
 * Reactivate a bar after permit renewal
 */
router.post('/reactivate/:barId', requireAuth, requireSuperAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { barId } = req.params;
    const { newExpiryDate } = req.body;

    if (!newExpiryDate) {
      return res.status(400).json({ 
        success: false, 
        message: 'New expiry date is required' 
      });
    }

    await conn.beginTransaction();

    // Get bar info
    const [bars] = await conn.query(
      'SELECT id, name, status FROM bars WHERE id = ?',
      [barId]
    );

    if (bars.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Bar not found' });
    }

    const bar = bars[0];

    // Update bar status and permit info
    await conn.query(
      `UPDATE bars 
       SET status = 'active',
           permit_status = 'valid',
           permit_expiry_date = ?,
           permit_expired_flagged_at = NULL,
           permit_expiry_notified_at = NULL
       WHERE id = ?`,
      [newExpiryDate, barId]
    );

    // Log audit
    await logAudit(
      barId,
      req.user.id,
      'REACTIVATE_BAR_PERMIT_RENEWED',
      'bars',
      barId,
      {
        new_expiry_date: newExpiryDate,
        previous_status: bar.status
      }
    );

    await conn.commit();

    return res.json({
      success: true,
      message: `Bar "${bar.name}" has been reactivated with new permit expiry date`
    });
  } catch (err) {
    await conn.rollback();
    console.error('POST /permit-monitoring/reactivate error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

/**
 * POST /permit-monitoring/run-check
 * Manually trigger permit expiry check (for testing)
 */
router.post('/run-check', requireAuth, async (req, res) => {
  try {
    const result = await runPermitExpiryCheck();
    return res.json({
      success: true,
      message: 'Permit expiry check completed',
      data: result
    });
  } catch (err) {
    console.error('POST /permit-monitoring/run-check error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /permit-monitoring/notifications/:barId
 * Get notification history for a specific bar
 */
router.get('/notifications/:barId', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { barId } = req.params;

    const [notifications] = await pool.query(
      `SELECT 
        id,
        notification_type,
        permit_expiry_date,
        email_sent,
        email_sent_at,
        created_at
       FROM permit_expiry_notifications
       WHERE bar_id = ?
       ORDER BY created_at DESC`,
      [barId]
    );

    return res.json({
      success: true,
      data: notifications
    });
  } catch (err) {
    console.error('GET /permit-monitoring/notifications error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
