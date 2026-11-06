const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    year: { type: Number, required: true },
    type: { type: String, enum: ['public', 'optional'], default: 'public' },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

holidaySchema.index({ companyId: 1, date: 1 });

module.exports = mongoose.model('Holiday', holidaySchema);
