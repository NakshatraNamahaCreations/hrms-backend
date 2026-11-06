require('dotenv').config();

const cron = require('node-cron');
const dayjs = require('dayjs');

const connectDB = require('./src/config/db');
const app = require('./src/app');
const Company = require('./src/models/Company');
const { emailPayslipsForMonth } = require('./src/controllers/payroll.controller');

const PORT = process.env.PORT || 5000;

// Monthly payslip auto-send — 09:00 on the 1st, previous month's PAID payslips
// for every active company (idempotent via payslipEmailedAt). Guard: DISABLE_CRON=true.
const schedulePayslipCron = () => {
  if (process.env.DISABLE_CRON === 'true') return;
  cron.schedule('0 9 1 * *', async () => {
    try {
      const prev = dayjs().subtract(1, 'month');
      const companies = await Company.find({ status: 'active', isDeleted: false }).select('_id name').lean();
      for (const company of companies) {
        // eslint-disable-next-line no-await-in-loop
        const { sent, skipped } = await emailPayslipsForMonth(company._id, prev.month() + 1, prev.year());
        // eslint-disable-next-line no-console
        console.log(`[payslip cron] ${company.name}: ${prev.format('MM/YYYY')} — ${sent} sent, ${skipped} skipped`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[payslip cron] failed:', err.message);
    }
  });
};

(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`HRMS backend running on http://localhost:${PORT} (api base: /api/v1)`);
    });
    schedulePayslipCron();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
})();
