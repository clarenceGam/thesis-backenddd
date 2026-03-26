require("dotenv").config();

// Set timezone to Philippine Time (Asia/Manila) for all Node.js operations
process.env.TZ = 'Asia/Manila';

// Startup env check
console.log('[ENV CHECK] GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'SET ✅' : 'MISSING ❌');

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { sanitizeInput } = require("./middlewares/sanitize");
const { uploadFallback, ensureDefaults } = require("./middlewares/uploadFallback");

// Import routes
const adminRoutes = require("./routes/admin");
const authRoutes = require("./routes/auth");
const ownerRoutes = require("./routes/owner");
const hrRoutes = require("./routes/hr");
const hrPermissionsRoutes = require("./routes/hrPermissions");
const attendanceRoutes = require("./routes/attendance");
const leaveRoutes = require("./routes/leave");
const hrDocumentsRoutes = require("./routes/hrDocuments");
const payrollRoutes = require("./routes/hrPayroll");
const deductionSettingsRoutes = require("./routes/deductionSettings");
const reservationRoutes = require("./routes/reservations");
const dssRoutes = require("./routes/dss");
const inventoryRoutes = require("./routes/inventory");
const superAdminRoutes = require("./routes/superAdmin");
const publicBarsRoutes = require("./routes/publicBars");
const reviewsRoutes = require("./routes/reviews");
const posRoutes = require("./routes/pos");
const socialRoutes = require("./routes/social");
const promotionsRoutes = require("./routes/promotions");
const subscriptionsRoutes = require("./routes/subscriptions");
const analyticsRoutes = require("./routes/analytics");
const ownerReviewsRoutes = require("./routes/ownerReviews");
const branchesRoutes = require("./routes/branches");
const paymentsRoutes = require("./routes/payments");
const subscriptionPaymentsRoutes = require("./routes/subscriptionPayments");
const paymongoWebhookRoutes = require("./routes/paymongoWebhook");
const payoutsRoutes = require("./routes/payouts");
const paymentCheckRoutes = require("./routes/paymentCheck");
const financialsRoutes = require("./routes/financials");
const superAdminPaymentsRoutes = require("./routes/superAdminPayments");
const feedWidgetsRoutes = require("./routes/feedWidgets");
const statsRoutes = require('./routes/stats');
const customerOrdersRoutes = require('./routes/customerOrders');

const app = express();

// ── Security headers (helmet) ──────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow serving uploads cross-origin
  contentSecurityPolicy: false, // managed by frontend
}));

// ── CORS – allow local frontend origins ─────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:4173',
    'http://127.0.0.1:5173',
    // Flutter web dev server (dynamic ports)
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
  ],
  credentials: true,
}));

// ── Rate limiters ──────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // max 20 attempts per IP (login/register only)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

const authSessionLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 120,                  // generous limit for session checks (/me, /refresh, etc.)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

// Apply global API rate limit
app.use(apiLimiter);

// PayMongo webhook requires raw body for signature verification / event parsing.
// Mount it before express.json() so the payload is not pre-parsed.
app.use("/webhook/paymongo", paymongoWebhookRoutes);
app.use(express.json({ limit: '2mb' }));
app.use(sanitizeInput); // strip null bytes, trim strings, enforce length limits
app.use("/uploads", express.static("uploads"));
app.use(uploadFallback); // Serve default avatar for missing profile images (prevents 404 spam)

const PORT = process.env.PORT || 3000;

// Routes
app.use("/health", (req, res) => {
  res.json({
    ok: true,
    message: "API is running",
  });
});

// PayMongo payment callback pages (shown after redirect)
app.get("/payment/success", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Successful</title>
    <style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0A;font-family:system-ui,sans-serif;color:#fff}
    .card{text-align:center;padding:48px;border-radius:16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)}
    .icon{font-size:64px;margin-bottom:16px}h1{margin:0 0 8px;font-size:24px}p{color:#999;margin:0 0 24px;font-size:15px}
    .btn{display:inline-block;padding:12px 32px;background:#CC0000;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px}</style></head>
    <body><div class="card"><div class="icon">✅</div><h1>Payment Successful!</h1>
    <p>Your reservation has been confirmed.<br>You can close this tab and return to the app.</p>
    <a href="javascript:window.close()" class="btn">Close This Tab</a></div></body></html>`);
});

app.get("/payment/failed", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Failed</title>
    <style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0A;font-family:system-ui,sans-serif;color:#fff}
    .card{text-align:center;padding:48px;border-radius:16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)}
    .icon{font-size:64px;margin-bottom:16px}h1{margin:0 0 8px;font-size:24px}p{color:#999;margin:0 0 24px;font-size:15px}
    .btn{display:inline-block;padding:12px 32px;background:#CC0000;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px}</style></head>
    <body><div class="card"><div class="icon">❌</div><h1>Payment Failed</h1>
    <p>Something went wrong with your payment.<br>You can close this tab and try again in the app.</p>
    <a href="javascript:window.close()" class="btn">Close This Tab</a></div></body></html>`);
});

app.use("/db-test", async (req, res) => {
  try {
    const pool = require("./config/database");
    const [rows] = await pool.query("SELECT 1 AS test");
    res.json({
      ok: true,
      rows,
    });
  } catch (err) {
    console.error("DB ERROR:", err.message);
    res.status(500).json({
      ok: false,
      message: "DB connection failed",
    });
  }
});

// API Routes
app.use("/admin", adminRoutes);
app.use("/super-admin", superAdminRoutes);
// Strict rate limit only on sensitive auth actions (login, register, password reset, google)
app.use("/auth/login", authLimiter);
app.use("/auth/register", authLimiter);
app.use("/auth/forgot-password", authLimiter);
app.use("/auth/reset-password", authLimiter);
app.use("/auth/google", authLimiter);
// Session checks (/me, /verify-email, etc.) use the generous limiter
app.use("/auth", authSessionLimiter, authRoutes);
app.use("/owner", ownerRoutes);
app.use("/hr", hrRoutes);
app.use("/hr", hrPermissionsRoutes);
app.use("/attendance", attendanceRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/", hrDocumentsRoutes);
app.use("/hr/payroll", payrollRoutes);
app.use("/hr/payroll", deductionSettingsRoutes);
// Public browse endpoints
app.use("/public", publicBarsRoutes);
app.use("/public", reviewsRoutes);
app.use("/public", reservationRoutes);
// Customer reservation actions + Owner reservation management share same file paths above
app.use("/", reservationRoutes);
app.use("/", dssRoutes);
app.use("/", inventoryRoutes);
app.use("/hr", require("./routes/hrAuditLogs"));
// POS system routes
app.use("/pos", posRoutes);
// Social / community routes (follows, likes, comments, notifications, etc.)
app.use("/social", socialRoutes);
// Platform feedback (customer reviews of the platform itself)
app.use("/platform-feedback", require("./routes/platformFeedback"));
// Promotions management (bar owners)
app.use("/promotions", promotionsRoutes);
// Subscription plans & management
app.use("/subscriptions", subscriptionsRoutes);
// Analytics & dashboard stats
app.use("/analytics", analyticsRoutes);
// Owner-side review management
app.use("/owner-reviews", ownerReviewsRoutes);
// Multi-branch management
app.use("/branches", branchesRoutes);
// Payment processing (customer orders/reservations)
app.use("/payments", paymentsRoutes);
// Subscription payment processing
app.use("/subscription-payments", subscriptionPaymentsRoutes);
// Payout management (bar owner earnings)
app.use("/payouts", payoutsRoutes);
// Payment verification (for local development)
app.use("/payment-check", paymentCheckRoutes);
// Financial analytics (auto-payout, cashflow)
app.use("/owner/financials", financialsRoutes);
// Super Admin payment control
app.use("/super-admin-payments", superAdminPaymentsRoutes);
// Feed widgets (sidebar data for customer app)
app.use("/feed-widgets", feedWidgetsRoutes);
// Platform statistics
app.use("/stats", statsRoutes);
// Customer web ordering (tax-aware)
app.use("/customer-orders", customerOrdersRoutes);

// Create default avatar on startup
ensureDefaults();

// ── Reservation Reminder Scheduler ──
// Send reminder notifications every 4 hours for reservations happening today
const { sendTodayReservationReminders } = require('./utils/reservationReminders');

// Run immediately on startup
sendTodayReservationReminders().catch(err => {
  console.error('[STARTUP] Failed to send initial reservation reminders:', err);
});

// Schedule to run every 4 hours (14400000 ms)
setInterval(() => {
  sendTodayReservationReminders().catch(err => {
    console.error('[SCHEDULER] Failed to send reservation reminders:', err);
  });
}, 4 * 60 * 60 * 1000);

console.log('✅ Reservation reminder scheduler initialized (runs every 4 hours)');

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// Start server
app.listen(PORT, () => console.log("Server running on port " + PORT));
