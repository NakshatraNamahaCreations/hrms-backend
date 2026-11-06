const mongoose = require('mongoose');

const policyAckSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Policy', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    acknowledgedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

policyAckSchema.index({ policyId: 1, employeeId: 1 }, { unique: true });

module.exports = mongoose.model('PolicyAck', policyAckSchema);
