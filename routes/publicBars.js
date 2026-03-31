const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const jwt = require("jsonwebtoken");

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

// ─── PUBLIC: Get bar menu with best seller indicators ───
router.get("/bars/:barId/menu-with-bestsellers", async (req, res) => {
  try {
    const barId = Number(req.params.barId);
    if (!barId) return res.status(400).json({ success: false, message: "Invalid bar ID" });

    // Check if reservation_items table exists (created by migration)
    const [riCheck] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reservation_items' LIMIT 1`
    );
    const hasReservationItems = riCheck.length > 0;

    const [menuItems] = await pool.query(
      hasReservationItems
        ? `SELECT 
            m.id,
            m.menu_name,
            m.category,
            m.menu_description,
            m.selling_price,
            i.image_path,
            i.stock_qty,
            COALESCE(SUM(ri.quantity), 0) AS total_sold,
            CASE WHEN COALESCE(SUM(ri.quantity), 0) > 0
              THEN RANK() OVER (PARTITION BY m.bar_id ORDER BY COALESCE(SUM(ri.quantity), 0) DESC)
              ELSE 999
            END AS sales_rank,
            0 AS is_best_seller
           FROM menu_items m
           JOIN inventory_items i ON i.id = m.inventory_item_id
           LEFT JOIN reservation_items ri ON ri.menu_item_id = m.id
           WHERE m.bar_id = ? AND m.is_available = 1 AND COALESCE(i.stock_qty, 0) > 0
           GROUP BY m.id, m.menu_name, m.category, m.menu_description, m.selling_price, i.image_path, i.stock_qty
           ORDER BY total_sold DESC, m.sort_order ASC, m.menu_name`
        : `SELECT 
            m.id,
            m.menu_name,
            m.category,
            m.menu_description,
            m.selling_price,
            i.image_path,
            i.stock_qty,
            0 AS is_best_seller,
            0 AS total_sold,
            999 AS sales_rank
           FROM menu_items m
           JOIN inventory_items i ON i.id = m.inventory_item_id
           WHERE m.bar_id = ? AND m.is_available = 1 AND COALESCE(i.stock_qty, 0) > 0
           ORDER BY m.sort_order ASC, m.category, m.menu_name`,
      [barId]
    );

    // Best Seller badge: only top 3 items by sales_rank, and only if bar has >= 5 menu items
    const totalItems = menuItems.length;
    for (const item of menuItems) {
      if (totalItems >= 5 && Number(item.sales_rank) <= 3 && Number(item.total_sold) > 0) {
        item.is_best_seller = 1;
      } else {
        item.is_best_seller = 0;
      }
    }

    return res.json({ success: true, data: menuItems });
  } catch (err) {
    console.error("GET MENU WITH BESTSELLERS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── PUBLIC: Trending bars (discovery ranking) ───
router.get("/bars/trending", async (req, res) => {
  try {
    const customerUserId = getOptionalUserId(req);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));

    const params = [limit];
    let banFilter = "";
    if (customerUserId) {
      banFilter =
        " AND NOT EXISTS (SELECT 1 FROM customer_bar_bans cbb WHERE cbb.bar_id = b.id AND cbb.customer_id = ?)";
      params.unshift(customerUserId);
    }

    const [rows] = await pool.query(
      `SELECT b.id, b.name, b.description, b.address, b.city, b.state, b.zip_code,
              b.contact_number AS phone, b.email, b.website, b.category, b.price_range, b.image_path,
              b.logo_path, b.video_path,
              b.logo_path AS bar_icon, b.video_path AS bar_gif,
              b.latitude, b.longitude, b.rating, b.review_count,
              (SELECT COUNT(*) FROM bar_followers bf WHERE bf.bar_id = b.id) AS follower_count,
              (SELECT COUNT(*) FROM reservations r WHERE r.bar_id = b.id) AS reservation_count,
              (
                (SELECT COUNT(*) FROM event_likes el WHERE el.event_id IN (SELECT be.id FROM bar_events be WHERE be.bar_id = b.id))
                +
                (SELECT COUNT(*) FROM event_comments ec WHERE ec.event_id IN (SELECT be2.id FROM bar_events be2 WHERE be2.bar_id = b.id) AND ec.status = 'active')
              ) AS event_engagement
       FROM bars b
       WHERE b.status = 'active'${banFilter}
       ORDER BY (
         (COALESCE((SELECT COUNT(*) FROM bar_followers bf WHERE bf.bar_id = b.id), 0) * 0.45)
         +
         (COALESCE(b.review_count, 0) * 0.20)
         +
         (COALESCE((SELECT COUNT(*) FROM reservations r WHERE r.bar_id = b.id), 0) * 0.20)
         +
         (COALESCE(
           (
             (SELECT COUNT(*) FROM event_likes el WHERE el.event_id IN (SELECT be.id FROM bar_events be WHERE be.bar_id = b.id))
             +
             (SELECT COUNT(*) FROM event_comments ec WHERE ec.event_id IN (SELECT be2.id FROM bar_events be2 WHERE be2.bar_id = b.id) AND ec.status = 'active')
           ),
           0
         ) * 0.15)
       ) DESC,
       b.rating DESC,
       b.review_count DESC,
       b.name ASC
       LIMIT ?`,
      params
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("PUBLIC TRENDING BARS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── PUBLIC: Get all active bars with coordinates (for Customer App map) ───
router.get("/bars", async (req, res) => {
  try {
    const { city, category, has_coords } = req.query;
    const customerUserId = getOptionalUserId(req);

    const where = ["b.status = 'active'"];
    const params = [];

    if (city) {
      where.push("b.city LIKE ?");
      params.push(`%${city}%`);
    }
    if (category) {
      where.push("LOWER(b.category) LIKE LOWER(?)");
      params.push(`%${String(category).trim()}%`);
    }
    if (has_coords === "1") {
      where.push("b.latitude IS NOT NULL AND b.longitude IS NOT NULL");
    }
    if (customerUserId) {
      where.push(
        "NOT EXISTS (SELECT 1 FROM customer_bar_bans cbb WHERE cbb.bar_id = b.id AND cbb.customer_id = ?)"
      );
      params.push(customerUserId);
    }

    const [rows] = await pool.query(
      `SELECT b.id, b.name, b.description, b.address, b.city, b.state, b.zip_code,
              b.contact_number AS phone, b.email, b.website, b.category, b.price_range, b.image_path,
              b.logo_path, b.video_path,
              b.logo_path AS bar_icon, b.video_path AS bar_gif,
              b.latitude, b.longitude, b.rating, b.review_count,
              (SELECT COUNT(*) FROM bar_followers bf WHERE bf.bar_id = b.id) AS follower_count,
              b.monday_hours, b.tuesday_hours, b.wednesday_hours,
              b.thursday_hours, b.friday_hours, b.saturday_hours, b.sunday_hours
       FROM bars b
       WHERE ${where.join(" AND ")}
       ORDER BY b.name ASC`,
      params
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("PUBLIC BARS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── PUBLIC: Get single bar detail ───
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
      `SELECT b.id, b.name, b.description, b.address, b.city, b.state, b.zip_code,
              b.contact_number AS phone, b.email, b.website, b.category, b.price_range, b.image_path,
              b.logo_path, b.video_path,
              b.logo_path AS bar_icon, b.video_path AS bar_gif,
              b.latitude, b.longitude, b.rating, b.review_count,
              (SELECT COUNT(*) FROM bar_followers bf WHERE bf.bar_id = b.id) AS follower_count,
              b.monday_hours, b.tuesday_hours, b.wednesday_hours,
              b.thursday_hours, b.friday_hours, b.saturday_hours, b.sunday_hours,
              b.accept_cash_payment, b.accept_online_payment, b.accept_gcash,
              b.minimum_reservation_deposit,
              b.bar_types, b.staff_types
       FROM bars b
       WHERE b.id = ? AND b.status = 'active'${banFilter}
       LIMIT 1`,
      params
    );

    if (!rows.length) return res.status(404).json({ success: false, message: "Bar not found" });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("PUBLIC BAR DETAIL ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── PUBLIC: Get bar menu items (available only, active bar) ───
router.get("/bars/:id/menu", async (req, res) => {
  try {
    const barId = Number(req.params.id);
    const customerUserId = getOptionalUserId(req);
    if (!barId) return res.status(400).json({ success: false, message: "Invalid bar id" });

    // Ensure bar is active
    const barCheckParams = [barId];
    let barCheckBanFilter = "";
    if (customerUserId) {
      barCheckBanFilter = " AND NOT EXISTS (SELECT 1 FROM customer_bar_bans cbb WHERE cbb.bar_id = bars.id AND cbb.customer_id = ?)";
      barCheckParams.push(customerUserId);
    }

    const [barCheck] = await pool.query(
      `SELECT id FROM bars WHERE id = ? AND status = 'active'${barCheckBanFilter} LIMIT 1`,
      barCheckParams
    );
    if (!barCheck.length) return res.status(404).json({ success: false, message: "Bar not found" });

    const [rows] = await pool.query(
      `SELECT m.id, m.bar_id, m.inventory_item_id, m.menu_name, m.menu_description,
              m.selling_price, m.category, m.is_available, m.sort_order,
              i.image_path, i.stock_qty
       FROM menu_items m
       JOIN inventory_items i ON i.id = m.inventory_item_id
       WHERE m.bar_id = ? AND m.is_available = 1 AND COALESCE(i.stock_qty, 0) > 0
       ORDER BY m.sort_order ASC, m.menu_name ASC`,
      [barId]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("PUBLIC BAR MENU ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── PUBLIC: Get bar events (active + today or future, active bar) ───
router.get("/bars/:id/events", async (req, res) => {
  try {
    const barId = Number(req.params.id);
    const customerUserId = getOptionalUserId(req);
    if (!barId) return res.status(400).json({ success: false, message: "Invalid bar id" });

    // Ensure bar is active
    const barCheckParams = [barId];
    let barCheckBanFilter = "";
    if (customerUserId) {
      barCheckBanFilter = " AND NOT EXISTS (SELECT 1 FROM customer_bar_bans cbb WHERE cbb.bar_id = bars.id AND cbb.customer_id = ?)";
      barCheckParams.push(customerUserId);
    }

    const [barCheck] = await pool.query(
      `SELECT id FROM bars WHERE id = ? AND status = 'active'${barCheckBanFilter} LIMIT 1`,
      barCheckParams
    );
    if (!barCheck.length) return res.status(404).json({ success: false, message: "Bar not found" });

    const userLikedSubquery = customerUserId 
      ? `(SELECT COUNT(*) > 0 FROM event_likes el WHERE el.event_id = bar_events.id AND el.user_id = ${customerUserId}) AS user_liked`
      : '0 AS user_liked';

    const [rows] = await pool.query(
      `SELECT id, bar_id, title, description, event_date, start_time, end_time,
              entry_price, max_capacity, current_bookings, status, image_url, image_path,
              (SELECT COUNT(*) FROM event_likes el WHERE el.event_id = bar_events.id) AS like_count,
              (SELECT COUNT(*) FROM event_comments ec WHERE ec.event_id = bar_events.id AND ec.status = 'active') AS comment_count,
              ${userLikedSubquery},
              created_at, updated_at
       FROM bar_events
       WHERE bar_id = ? AND status = 'active'
       ORDER BY event_date >= CURDATE() DESC, event_date ASC, start_time ASC`,
      [barId]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("PUBLIC BAR EVENTS ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── PUBLIC: Get single event detail with comments + replies ───
router.get("/bars/:barId/events/:eventId", async (req, res) => {
  try {
    const barId = Number(req.params.barId);
    const eventId = Number(req.params.eventId);
    const customerUserId = getOptionalUserId(req);
    if (!barId || !eventId) return res.status(400).json({ success: false, message: "Invalid params" });

    const [eventRows] = await pool.query(
      `SELECT id, bar_id, title, description, event_date, start_time, end_time,
              entry_price, max_capacity, current_bookings, status, image_url, image_path,
              (SELECT COUNT(*) FROM event_likes el WHERE el.event_id = bar_events.id) AS like_count,
              (SELECT COUNT(*) FROM event_comments ec WHERE ec.event_id = bar_events.id AND ec.status = 'active') AS comment_count,
              created_at, updated_at
       FROM bar_events
       WHERE id = ? AND bar_id = ? AND status = 'active'
       LIMIT 1`,
      [eventId, barId]
    );
    if (!eventRows.length) return res.status(404).json({ success: false, message: "Event not found" });
    const event = eventRows[0];

    // Resolve bar owner user IDs for is_bar_owner flag
    const [ownerRows] = await pool.query(
      `SELECT u.id FROM users u
       JOIN bar_owners bo ON bo.user_id = u.id
       JOIN bars b ON b.owner_id = bo.id
       WHERE b.id = ?`,
      [barId]
    );
    const ownerUserIds = ownerRows.map(r => r.id);

    // Whether the current customer liked this event
    let userLiked = false;
    if (customerUserId) {
      const [likeRows] = await pool.query(
        "SELECT 1 FROM event_likes WHERE event_id = ? AND user_id = ? LIMIT 1",
        [eventId, customerUserId]
      );
      userLiked = likeRows.length > 0;
    }

    // Fetch comments
    const [comments] = await pool.query(
      `SELECT ec.id, ec.user_id, ec.comment, ec.created_at,
              u.first_name, u.last_name, u.profile_picture, u.role
       FROM event_comments ec
       JOIN users u ON u.id = ec.user_id
       WHERE ec.event_id = ? AND ec.status = 'active'
       ORDER BY ec.created_at DESC`,
      [eventId]
    );

    // Fetch replies for all comments in one query
    let enrichedComments = [];
    if (comments.length) {
      const commentIds = comments.map(c => c.id);
      const placeholders = commentIds.map(() => "?").join(",");
      const [replyRows] = await pool.query(
        `SELECT ecr.id, ecr.event_comment_id, ecr.user_id, ecr.reply, ecr.created_at,
                u.first_name, u.last_name, u.profile_picture, u.role
         FROM event_comment_replies ecr
         JOIN users u ON u.id = ecr.user_id
         WHERE ecr.event_comment_id IN (${placeholders}) AND ecr.status = 'active'
         ORDER BY ecr.created_at ASC`,
        commentIds
      );

      const repliesByCommentId = {};
      for (const r of replyRows) {
        if (!repliesByCommentId[r.event_comment_id]) repliesByCommentId[r.event_comment_id] = [];
        repliesByCommentId[r.event_comment_id].push({
          id: r.id,
          reply: r.reply,
          user_id: r.user_id,
          user_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
          profile_picture: r.profile_picture,
          is_bar_owner: ownerUserIds.includes(r.user_id) || String(r.role || '').toLowerCase() === 'bar_owner',
          created_at: r.created_at,
        });
      }

      enrichedComments = comments.map(c => ({
        id: c.id,
        user_id: c.user_id,
        comment: c.comment,
        user_name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        profile_picture: c.profile_picture,
        is_bar_owner: ownerUserIds.includes(c.user_id) || String(c.role || '').toLowerCase() === 'bar_owner',
        created_at: c.created_at,
        replies: repliesByCommentId[c.id] || [],
      }));
    }

    return res.json({
      success: true,
      data: {
        ...event,
        user_liked: userLiked,
        comments: enrichedComments,
      },
    });
  } catch (err) {
    console.error("PUBLIC EVENT DETAIL ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── PUBLIC: Get bar tables (active only, active bar) ───
router.get("/bars/:id/tables", async (req, res) => {
  try {
    const barId = Number(req.params.id);
    const customerUserId = getOptionalUserId(req);
    if (!barId) return res.status(400).json({ success: false, message: "Invalid bar id" });

    // Ensure bar is active
    const barCheckParams = [barId];
    let barCheckBanFilter = "";
    if (customerUserId) {
      barCheckBanFilter = " AND NOT EXISTS (SELECT 1 FROM customer_bar_bans cbb WHERE cbb.bar_id = bars.id AND cbb.customer_id = ?)";
      barCheckParams.push(customerUserId);
    }

    const [barCheck] = await pool.query(
      `SELECT id FROM bars WHERE id = ? AND status = 'active'${barCheckBanFilter} LIMIT 1`,
      barCheckParams
    );
    if (!barCheck.length) return res.status(404).json({ success: false, message: "Bar not found" });

    const [rows] = await pool.query(
      `SELECT id, bar_id, table_number, capacity, is_active, created_at, image_path, price
       FROM bar_tables
       WHERE bar_id = ? AND is_active = 1 AND deleted_at IS NULL
       ORDER BY capacity ASC, table_number ASC`,
      [barId]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("PUBLIC BAR TABLES ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── PUBLIC: Get bar packages with inclusions ───
router.get("/bars/:id/packages", async (req, res) => {
  try {
    const barId = Number(req.params.id);
    if (!barId) return res.status(400).json({ success: false, message: "Invalid bar ID" });

    // Verify bar is active
    const [barCheck] = await pool.query(
      "SELECT id FROM bars WHERE id = ? AND status = 'active' LIMIT 1",
      [barId]
    );
    if (!barCheck.length) return res.status(404).json({ success: false, message: "Bar not found" });

    // Fetch packages
    const [packages] = await pool.query(
      `SELECT id, name, description, price, created_at
       FROM bar_packages
       WHERE bar_id = ? AND is_active = 1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [barId]
    );

    // Fetch inclusions for each package and check stock availability
    for (const pkg of packages) {
      const [inclusions] = await pool.query(
        `SELECT id, item_name, quantity
         FROM package_inclusions
         WHERE package_id = ?
         ORDER BY id ASC`,
        [pkg.id]
      );
      pkg.inclusions = inclusions;
      
      // Check if all items are in stock
      pkg.is_available = true;
      pkg.unavailable_reason = null;
      let maxPackageQty = null;
      
      for (const item of inclusions) {
        // Try to find matching inventory item by name
        const [stockCheck] = await pool.query(
          `SELECT i.name, i.stock_qty, m.menu_name
           FROM inventory_items i
           LEFT JOIN menu_items m ON m.inventory_item_id = i.id AND m.bar_id = ?
           WHERE i.bar_id = ? AND (i.name = ? OR m.menu_name = ?)
           LIMIT 1`,
          [barId, barId, item.item_name, item.item_name]
        );
        
        if (stockCheck.length > 0) {
          const stock = Number(stockCheck[0].stock_qty || 0);
          const inclusionQty = Math.max(1, Number(item.quantity || 1));
          const packageUnitsFromThisItem = Math.floor(stock / inclusionQty);
          maxPackageQty = maxPackageQty === null ? packageUnitsFromThisItem : Math.min(maxPackageQty, packageUnitsFromThisItem);
          if (packageUnitsFromThisItem <= 0) {
            pkg.is_available = false;
            pkg.unavailable_reason = `${item.item_name} is currently out of stock`;
            break;
          }
        }
      }

      pkg.stock_qty = Math.max(0, Number(maxPackageQty ?? 0));
      if (pkg.is_available && inclusions.length > 0 && pkg.stock_qty <= 0) {
        pkg.is_available = false;
        pkg.unavailable_reason = 'Package is currently out of stock';
      }
    }

    return res.json({ success: true, data: packages });
  } catch (err) {
    console.error("PUBLIC BAR PACKAGES ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
