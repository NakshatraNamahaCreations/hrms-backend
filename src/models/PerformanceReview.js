const mongoose = require('mongoose');

const reviewSectionSchema = new mongoose.Schema(
  {
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    ratings: { type: Object, default: {} }, // criteria -> score
    comments: { type: String, default: null },
    submittedAt: { type: Date, default: null },
  },
  { _id: false }
);

const performanceReviewSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'PerformanceCycle', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    selfReview: { type: reviewSectionSchema, default: null },
    managerReview: { type: reviewSectionSchema, default: null },
    hrReview: { type: reviewSectionSchema, default: null },
    finalRating: { type: Number, min: 1, max: 5, default: null },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    finalizedAt: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'in_progress', 'finalized'], default: 'pending' },
  },
  { timestamps: true }
);

performanceReviewSchema.index({ companyId: 1, cycleId: 1, employeeId: 1 }, { unique: true });

module.exports = mongoose.model('PerformanceReview', performanceReviewSchema);
