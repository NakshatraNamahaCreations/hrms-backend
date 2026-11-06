const mongoose = require('mongoose');
const { TICKET_STATUS, TICKET_CATEGORIES } = require('../constants');

const ticketSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ticketNumber: { type: String, required: true },
    category: { type: String, enum: TICKET_CATEGORIES, default: 'other' },
    subject: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    status: { type: String, enum: TICKET_STATUS, default: 'open' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    comments: [
      {
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: String,
        message: String,
        at: { type: Date, default: Date.now },
      },
    ],
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

ticketSchema.index({ companyId: 1, ticketNumber: 1 }, { unique: true });

module.exports = mongoose.model('Ticket', ticketSchema);
