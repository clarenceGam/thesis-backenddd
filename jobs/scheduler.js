const cron = require('node-cron');
const { checkPermitExpiry } = require('./permitExpiryChecker');

/**
 * Job Scheduler
 * Manages all scheduled background jobs
 */

function startScheduler() {
  console.log('[Scheduler] Starting background jobs...');

  // Run permit expiry checker daily at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    console.log('[Scheduler] Running permit expiry check...');
    try {
      await checkPermitExpiry();
    } catch (err) {
      console.error('[Scheduler] Permit expiry check failed:', err);
    }
  }, {
    timezone: 'Asia/Manila'
  });

  console.log('[Scheduler] Permit expiry checker scheduled (daily at 2:00 AM PHT)');
}

module.exports = { startScheduler };
