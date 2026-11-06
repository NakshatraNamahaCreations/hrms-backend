const mongoose = require('mongoose');
const { EXPENSE_STATUS } = require('../constants');

const fieldExpenseSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    workAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'FieldWorkAssignment', default: null },
    date: { type: String, required: true }, // YYYY-MM-DD
    category: { type: String, enum: ['travel', 'food', 'lodging', 'parking', 'material', 'other'], default: 'travel' },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, default: null },
    receipt: { type: String, default: null },
    status: { type: String, enum: EXPENSE_STATUS, default: 'submitted' },
    actionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actionAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    paidAt: { type: Date, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

fieldExpenseSchema.index({ companyId: 1, employeeId: 1, date: 1 });

module.exports = mongoose.model('FieldExpense', fieldExpenseSchema);
