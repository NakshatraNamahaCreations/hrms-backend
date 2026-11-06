const mongoose = require('mongoose');
const { FEATURE_REQUEST_STATUS } = require('../constants');

const featureRequestSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    featureKey: { type: String, default: null },
    status: { type: String, enum: FEATURE_REQUEST_STATUS, default: 'requested' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    quoteAmount: { type: Number, default: null },
    estimatedDays: { type: Number, default: null },
    assignee: { type: String, default: null },
    ownerNotes: { type: String, default: null },
    statusHistory: [
      {
        status: { type: String, enum: FEATURE_REQUEST_STATUS },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: String,
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('FeatureRequest', featureRequestSchema);
