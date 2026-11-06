const mongoose = require('mongoose');
const { PROJECT_MODULES } = require('../constants');

/**
 * An industry blueprint for projects: the vocabulary, the phases, which phases
 * need a client sign-off, which modules the project gets and the two headline
 * KPIs the list shows.
 *
 * Blueprints are per company, not global, so a tenant can clone one and edit
 * its phases without a code change. `key` identifies the blueprint a seeded
 * template came from; a company's own copy keeps the key so updates can be
 * matched, and `isCustom` marks one the company built itself.
 */
const phaseSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // A gate phase cannot be left behind until the client has signed it off.
    gate: { type: Boolean, default: false },
  },
  { _id: false }
);

const projectTemplateSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    key: { type: String, required: true, trim: true }, // 'interior', 'adfilm', …
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true }, // project code prefix, e.g. INT
    vocab: {
      project: { type: String, default: 'Project' },
      projects: { type: String, default: 'Projects' },
      item: { type: String, default: 'Task' },
      items: { type: String, default: 'Tasks' },
      newLabel: { type: String, default: 'New project' },
    },
    phases: { type: [phaseSchema], default: [] },
    modules: [{ type: String, enum: PROJECT_MODULES }],
    billing: { type: String, default: 'Milestone billing' },
    isCustom: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

projectTemplateSchema.index({ companyId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('ProjectTemplate', projectTemplateSchema);
