const mongoose = require('mongoose');

// One finance-settings doc per company. Drives the owner-only Profit Intelligence
// dashboards (Employee Profitability, Project Economics, Profit & Savings, Breakup).
const companyFinanceSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true,
      index: true,
    },
    // Fixed monthly overheads (₹).
    overheads: {
      electricity: { type: Number, default: 0 },
      internet: { type: Number, default: 0 },
      rent: { type: Number, default: 0 },
      software: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
    },
    taxPercent: { type: Number, default: 20 },
    safeDepositPercent: { type: Number, default: 20 },
    savedAmount: { type: Number, default: 0 },
    safetyFundMonths: { type: Number, default: 3 },
    targetMarginPercent: { type: Number, default: 30 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CompanyFinance', companyFinanceSchema);
