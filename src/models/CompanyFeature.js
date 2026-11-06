const mongoose = require('mongoose');
const { FEATURE_KEYS } = require('../constants');

const companyFeatureSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    featureKey: { type: String, enum: FEATURE_KEYS, required: true },
    enabled: { type: Boolean, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

companyFeatureSchema.index({ companyId: 1, featureKey: 1 }, { unique: true });

module.exports = mongoose.model('CompanyFeature', companyFeatureSchema);
