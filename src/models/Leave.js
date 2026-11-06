const mongoose = require('mongoose');
const { LEAVE_STATUS, LEAVE_TYPES } = require('../constants');

// One step of the multi-level approval chain (L1 manager → L2 hr_admin → L3 company_admin)
const approvalStepSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true },
    role: { type: String, required: true }, // manager | hr_admin | company_admin
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: null },
    note: { type: String, default: null },
  },
  { _id: false }
);

const leaveSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveType: { type: String, enum: LEAVE_TYPES, required: true },
    fromDate: { type: String, required: true }, // YYYY-MM-DD
    toDate: { type: String, required: true },
    days: { type: Number, required: true, min: 0.5 },
    halfDay: { type: Boolean, default: false },
    reason: { type: String, required: true },
    status: { type: String, enum: LEAVE_STATUS, default: 'pending' },
    approvalChain: { type: [approvalStepSchema], default: [] }, // empty = legacy single-level behaviour
    currentLevel: { type: Number, default: 1 },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

leaveSchema.index({ companyId: 1, employeeId: 1, fromDate: 1 });

module.exports = mongoose.model('Leave', leaveSchema);
