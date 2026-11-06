const mongoose = require('mongoose');
const { LOAN_STATUS, LOAN_TYPES, LOAN_PAYMENT_METHODS } = require('../constants');

// EMI payment ledger entry — one per paidEmis increment (payroll posting or manual receipt)
const loanPaymentSchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true }, // 1-based EMI sequence number
    amount: { type: Number, required: true },
    method: { type: String, enum: LOAN_PAYMENT_METHODS, required: true },
    paidAt: { type: Date, required: true },
    month: { type: Number, default: null }, // payroll-method only
    year: { type: Number, default: null }, // payroll-method only
    payrollId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', default: null },
    note: { type: String, default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

const loanSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    type: { type: String, enum: LOAN_TYPES, default: 'loan' },
    amount: { type: Number, required: true, min: 1 },
    reason: { type: String, default: null },
    emiAmount: { type: Number, default: 0 }, // set on approval
    totalEmis: { type: Number, default: 0 }, // set on approval
    paidEmis: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }, // initialized = amount on disburse
    payments: { type: [loanPaymentSchema], default: [] }, // EMI ledger (v1.6) — legacy loans may have paidEmis > payments.length
    status: { type: String, enum: LOAN_STATUS, default: 'requested' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    disbursedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
  },
  { timestamps: true }
);

loanSchema.index({ companyId: 1, employeeId: 1, status: 1 });

module.exports = mongoose.model('Loan', loanSchema);
