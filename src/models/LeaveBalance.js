const mongoose = require('mongoose');

const bucketSchema = new mongoose.Schema(
  {
    total: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
  },
  { _id: false }
);

const leaveBalanceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    year: { type: Number, required: true },
    balances: {
      casual: { type: bucketSchema, default: () => ({}) },
      sick: { type: bucketSchema, default: () => ({}) },
      earned: { type: bucketSchema, default: () => ({}) },
    },
  },
  { timestamps: true }
);

leaveBalanceSchema.index({ companyId: 1, employeeId: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('LeaveBalance', leaveBalanceSchema);
