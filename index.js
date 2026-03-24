require("dotenv").config();

// Set timezone to Philippine Time (Asia/Manila) for all Node.js operations
process.env.TZ = 'Asia/Manila';

// Force IPv4 DNS resolution (fixes ENETUNREACH on Railway's IPv6)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const origLookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = { family: 4 };
  } else if (typeof options === 'number') {
    options = { family: 4 };
  } else {
    options = Object.assign({}, options, { family: 4 });
  }
  origLookup.call(dns, hostname, options, callback);
};

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

const app = express();

// Trust proxy for Railway deployment (behind reverse proxy)
app.set('trust proxy', 1);

// ── Security headers (helmet) ──────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow serving uploads cross-origin
  contentSecurityPolicy: false, // managed by frontend
}));

// ── CORS – restrict to known frontend origins ──────────────────────────────
const _frontendUrl = process.env.FRONTEND_URL;
const _wwwVariant = _frontendUrl
  ? _frontendUrl.replace(/^(https?:\/\/)(?!www\.)/, '$1www.')
  : null;
const ALLOWED_ORIGINS = [
  _frontendUrl,
  _wwwVariant,
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
].filter(Boolean);

console.log('🔧 FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('🔧 ALLOWED_ORIGINS:', ALLOWED_ORIGINS);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Rate limiters ──────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // max 20 attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
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
app.use("/auth", authLimiter, authRoutes); // auth endpoints get stricter rate limiting
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

// Create default avatar on startup
ensureDefaults();

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
