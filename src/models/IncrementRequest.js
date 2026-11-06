const mongoose = require('mongoose');
const { INCREMENT_STATUS } = require('../constants');

const incrementRequestSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    currentCtc: { type: Number, required: true, min: 0 }, // snapshot of employee.salary.ctc at submit
    requestedCtc: { type: Number, required: true, min: 1 },
    reason: { type: String, default: null },
    status: { type: String, enum: INCREMENT_STATUS, default: 'requested' },
    reviewNote: { type: String, default: null },
    actionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actionAt: { type: Date, default: null },
  },
  { timestamps: true }
);

incrementRequestSchema.index({ companyId: 1, employeeId: 1, status: 1 });

module.exports = mongoose.model('IncrementRequest', incrementRequestSchema);
