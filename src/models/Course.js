const mongoose = require('mongoose');
const { COURSE_TYPES } = require('../constants');

const courseSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: COURSE_TYPES, required: true },
    url: { type: String, required: true }, // video/pdf/link location
    description: { type: String, default: '' },
    durationMinutes: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

courseSchema.index({ companyId: 1, active: 1 });

module.exports = mongoose.model('Course', courseSchema);
