const mongoose = require('mongoose');
const { ATTENDANCE_STATUS, ATTENDANCE_SOURCE } = require('../constants');

const punchSchema = new mongoose.Schema(
  {
    time: { type: Date },
    location: { latitude: Number, longitude: Number, address: String },
    device: { type: String, default: null },
    source: { type: String, enum: ATTENDANCE_SOURCE, default: 'web' },
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
    checkIn: { type: punchSchema, default: null },
    checkOut: { type: punchSchema, default: null },
    status: { type: String, enum: ATTENDANCE_STATUS, default: 'present' },
    attendanceSource: { type: String, enum: ATTENDANCE_SOURCE, default: 'web' },
    lateMinutes: { type: Number, default: 0 },
    earlyExitMinutes: { type: Number, default: 0 },
    totalHours: { type: Number, default: 0 },
    workMinutes: { type: Number, default: 0 },
    remarks: { type: String, default: null },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isLocked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

attendanceSchema.index({ companyId: 1, employeeId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ companyId: 1, date: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
