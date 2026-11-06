const mongoose = require('mongoose');
const { CORRECTION_STATUS, ATTENDANCE_STATUS } = require('../constants');

const attendanceCorrectionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    requestedCheckIn: { type: Date, default: null },
    requestedCheckOut: { type: Date, default: null },
    requestedStatus: { type: String, enum: [...ATTENDANCE_STATUS, null], default: null },
    reason: { type: String, required: true },
    status: { type: String, enum: CORRECTION_STATUS, default: 'pending' },
    managerActionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    managerActionAt: { type: Date, default: null },
    hrActionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    hrActionAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
  },
  { timestamps: true }
);

attendanceCorrectionSchema.index({ companyId: 1, employeeId: 1, date: 1 });

module.exports = mongoose.model('AttendanceCorrection', attendanceCorrectionSchema);
