const mongoose = require('mongoose');

const biometricLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'BiometricDevice', required: true },
    biometricUserId: { type: String, required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    timestamp: { type: Date, required: true },
    direction: { type: String, enum: ['in', 'out', 'unknown'], default: 'unknown' },
    processed: { type: Boolean, default: false },
    raw: { type: Object, default: {} },
  },
  { timestamps: true }
);

biometricLogSchema.index({ companyId: 1, employeeId: 1, timestamp: 1 });

module.exports = mongoose.model('BiometricLog', biometricLogSchema);
