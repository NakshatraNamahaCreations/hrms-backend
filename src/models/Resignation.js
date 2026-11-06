const mongoose = require('mongoose');
const { RESIGNATION_STATUS } = require('../constants');

const resignationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    reason: { type: String, required: true },
    resignationDate: { type: Date, default: Date.now },
    noticePeriodDays: { type: Number, default: 30 },
    lastWorkingDate: { type: Date, default: null },
    status: { type: String, enum: RESIGNATION_STATUS, default: 'applied' },
    managerActionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    managerActionAt: { type: Date, default: null },
    managerNote: { type: String, default: null },
    hrActionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    hrActionAt: { type: Date, default: null },
    hrNote: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    // Flexible checklist: standard items seeded by default, companies may track their own
    checklist: {
      type: [
        new mongoose.Schema(
          { item: { type: String, required: true }, done: { type: Boolean, default: false } },
          { _id: false }
        ),
      ],
      default: () => [
        { item: 'Assets returned', done: false },
        { item: 'Full & final settled', done: false },
        { item: 'Exit interview done', done: false },
        { item: 'Access revoked', done: false },
        { item: 'Documents handed over', done: false },
      ],
    },
    fnfAmount: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    experienceLetterDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeDocument', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Resignation', resignationSchema);
