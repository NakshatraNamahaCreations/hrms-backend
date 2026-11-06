const mongoose = require('mongoose');
const { PROJECT_MODULES } = require('../constants');

/**
 * One row inside any of a project's modules — a client approval, a change
 * order, a snag, a purchase order, a shoot day, a licence, a drawing, a
 * statutory deadline, a daily progress report, a vendor, a deliverable, a
 * session, a service visit or a requested client document.
 *
 * These share a single collection because they share a shape: a title, an
 * owner, a date that can fall due, a money amount and a status. Their
 * module-specific fields live in `data`, which the project template's column
 * spec decides how to render. Fourteen near-identical collections would have to
 * be queried, indexed, scoped and permissioned fourteen times over for no gain.
 *
 * The fields promoted out of `data` are the ones the server reasons about:
 * due dates drive "coming up" and overdue states, `amount` rolls into cost,
 * `sentOn` drives how long the client has been sitting on an approval.
 */
const projectModuleItemSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    module: { type: String, enum: PROJECT_MODULES, required: true },

    title: { type: String, required: true, trim: true },
    status: { type: String, default: 'open', trim: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },

    // Scheduling. `dueDate` is what "coming up", "overdue" and the deadline
    // signals read; a shoot day or a session uses it as its date.
    dueDate: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // Client sign-off clock. Set when the item goes to the client; cleared when
    // they decide. Time spent waiting here is excluded from schedule health.
    sentOn: { type: Date, default: null },
    decidedOn: { type: Date, default: null },

    // Money. `amount` is the committed value (PO, vendor, change order) and
    // counts toward project cost once the item is not cancelled or rejected.
    amount: { type: Number, default: 0 },
    daysImpact: { type: Number, default: 0 }, // change orders only

    data: { type: Object, default: {} },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

projectModuleItemSchema.index({ companyId: 1, projectId: 1, module: 1, isDeleted: 1 });
projectModuleItemSchema.index({ companyId: 1, module: 1, dueDate: 1 });

module.exports = mongoose.model('ProjectModuleItem', projectModuleItemSchema);
