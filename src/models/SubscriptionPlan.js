const mongoose = require('mongoose');
const { FEATURE_KEYS } = require('../constants');

const subscriptionPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    monthlyPrice: { type: Number, required: true, min: 0 },
    yearlyPrice: { type: Number, required: true, min: 0 },
    employeeLimit: { type: Number, required: true, min: 0 },
    fieldEmployeeLimit: { type: Number, required: true, min: 0 },
    enabledFeatures: [{ type: String, enum: FEATURE_KEYS }],
    trialDays: { type: Number, default: 14 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
