const mongoose = require('mongoose');
const { PROJECT_STATUS, PROJECT_BILLING } = require('../constants');

/**
 * A phase copied from the template at creation, then dated and tracked here.
 * Dates live on the project, not the template, because every project runs its
 * own calendar off the same blueprint.
 */
const projectPhaseSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    gate: { type: Boolean, default: false }, // needs a client sign-off to pass
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    // Set when the phase actually finished, so slip is measured, not guessed.
    completedAt: { type: Date, default: null },
    signedOffAt: { type: Date, default: null }, // gate phases only
    signedOffBy: { type: String, default: null }, // the client contact who approved
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, default: null, trim: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    description: { type: String, default: '' },
    status: { type: String, enum: PROJECT_STATUS, default: 'active' },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],

    // The blueprint this project was created from. Phases are copied in rather
    // than referenced, so editing a template never rewrites live projects.
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProjectTemplate', default: null },
    phases: { type: [projectPhaseSchema], default: [] },
    currentPhase: { type: Number, default: 0 }, // index into phases

    // Money. `contractValue` is what the client pays, `budget` is what we
    // allow ourselves to spend delivering it. Margin is the gap, forecast
    // forward from the work done so far.
    contractValue: { type: Number, default: 0 },
    budget: { type: Number, default: 0 },
    billingType: { type: String, enum: [...PROJECT_BILLING, null], default: null },

    // Percent of work complete. Set from task completion when tasks exist, and
    // overridable by the manager when they do not.
    progressOverride: { type: Number, min: 0, max: 100, default: null },

    holdReason: { type: String, default: null },
    heldAt: { type: Date, default: null },
    // Days the project sat on hold, accumulated on resume. The schedule
    // forecast adds these back so a paused project is not marked late for it.
    holdDays: { type: Number, default: 0 },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

projectSchema.index({ companyId: 1, status: 1 });
projectSchema.index({ companyId: 1, templateId: 1 });

module.exports = mongoose.model('Project', projectSchema);
