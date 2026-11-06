const mongoose = require('mongoose');
const { PAYMENT_STATUS, BILLING_CYCLES } = require('../constants');

const paymentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanySubscription', default: null },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', default: null },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    billingCycle: { type: String, enum: BILLING_CYCLES, default: 'monthly' },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    razorpaySignature: { type: String, default: null },
    status: { type: String, enum: PAYMENT_STATUS, default: 'created' },
    method: { type: String, default: null },
    mode: { type: String, enum: ['live', 'mock'], default: 'mock' },
    invoiceNumber: { type: String, default: null },
    paidAt: { type: Date, default: null },
    notes: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
