const mongoose = require('mongoose');

const fieldLocationLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    workAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'FieldWorkAssignment', default: null },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    accuracy: { type: Number, default: null },
    speed: { type: Number, default: null },
    capturedAt: { type: Date, required: true },
    batteryLevel: { type: Number, default: null },
    deviceId: { type: String, default: null },
    trackingType: { type: String, enum: ['interval', 'checkin', 'checkout', 'manual'], default: 'interval' },
  },
  { timestamps: true }
);

fieldLocationLogSchema.index({ companyId: 1, employeeId: 1, capturedAt: 1 });

module.exports = mongoose.model('FieldLocationLog', fieldLocationLogSchema);
