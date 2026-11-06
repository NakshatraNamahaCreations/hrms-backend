const mongoose = require('mongoose');

const payslipSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    payrollId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', required: true },
    month: { type: Number, required: true },
    year: { type: Number, required: true },
    payslipNumber: { type: String, required: true },
    data: { type: Object, default: {} }, // frozen snapshot used to render payslip
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

payslipSchema.index({ companyId: 1, employeeId: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('Payslip', payslipSchema);
