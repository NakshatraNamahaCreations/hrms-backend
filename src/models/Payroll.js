const mongoose = require('mongoose');
const { PAYROLL_STATUS } = require('../constants');

const payrollSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    totalDays: { type: Number, default: 0 },
    presentDays: { type: Number, default: 0 },
    halfDays: { type: Number, default: 0 },
    paidLeaveDays: { type: Number, default: 0 },
    holidayDays: { type: Number, default: 0 },
    weekOffDays: { type: Number, default: 0 },
    payableDays: { type: Number, default: 0 },
    lopDays: { type: Number, default: 0 },
    fieldDays: { type: Number, default: 0 },
    travelKm: { type: Number, default: 0 },
    earnings: {
      basic: { type: Number, default: 0 },
      hra: { type: Number, default: 0 },
      conveyance: { type: Number, default: 0 },
      medicalAllowance: { type: Number, default: 0 },
      specialAllowance: { type: Number, default: 0 },
      otherAllowances: { type: Number, default: 0 },
      fieldAllowance: { type: Number, default: 0 },
      travelAllowance: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
    },
    deductions: {
      pf: { type: Number, default: 0 },
      esi: { type: Number, default: 0 },
      professionalTax: { type: Number, default: 0 },
      tds: { type: Number, default: 0 },
      loanEmi: { type: Number, default: 0 },
      lopAmount: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    netSalary: { type: Number, default: 0 },
    status: { type: String, enum: PAYROLL_STATUS, default: 'draft' },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    payslipEmailedAt: { type: Date, default: null }, // idempotency guard for payslip emailing
    loanEmisPosted: { type: Boolean, default: false }, // idempotency guard for EMI posting on mark-paid
    lockedAt: { type: Date, default: null },
    remarks: { type: String, default: null },
  },
  { timestamps: true }
);

payrollSchema.index({ companyId: 1, employeeId: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('Payroll', payrollSchema);
