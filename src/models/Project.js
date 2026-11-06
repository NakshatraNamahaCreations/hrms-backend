const mongoose = require('mongoose');
const { PROJECT_STATUS } = require('../constants');

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
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

projectSchema.index({ companyId: 1, status: 1 });

module.exports = mongoose.model('Project', projectSchema);
