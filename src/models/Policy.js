const mongoose = require('mongoose');

const policySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    fileUrl: { type: String, default: null }, // uploaded file or external url
    version: { type: Number, default: 1 }, // bumped whenever the file changes
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

policySchema.index({ companyId: 1, active: 1 });

module.exports = mongoose.model('Policy', policySchema);
