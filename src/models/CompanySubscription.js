const mongoose = require('mongoose');
const { SUBSCRIPTION_STATUS, BILLING_CYCLES } = require('../constants');

const companySubscriptionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    billingCycle: { type: String, enum: BILLING_CYCLES, default: 'monthly' },
    status: { type: String, enum: SUBSCRIPTION_STATUS, default: 'trial' },
    employeeLimit: { type: Number, required: true },
    fieldEmployeeLimit: { type: Number, required: true },
    amount: { type: Number, default: 0 },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CompanySubscription', companySubscriptionSchema);
