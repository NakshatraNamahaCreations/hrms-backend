const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    startTime: { type: String, required: true }, // "HH:mm"
    endTime: { type: String, required: true },
    graceMinutes: { type: Number, default: 15 },
    halfDayHours: { type: Number, default: 4 },
    fullDayHours: { type: Number, default: 8 },
    isNightShift: { type: Boolean, default: false },
    weekOffDays: { type: [Number], default: [0] },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Shift', shiftSchema);
