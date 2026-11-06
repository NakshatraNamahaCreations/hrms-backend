const mongoose = require('mongoose');
const { ASSET_STATUS } = require('../constants');

const assetSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, default: null, trim: true },
    category: { type: String, default: 'other' },
    serialNumber: { type: String, default: null },
    purchaseDate: { type: Date, default: null },
    value: { type: Number, default: 0 },
    condition: { type: String, default: 'good' },
    status: { type: String, enum: ASSET_STATUS, default: 'available' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    assignmentHistory: [
      {
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
        assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        assignedAt: { type: Date, default: Date.now },
        returnedAt: { type: Date, default: null },
        returnCondition: { type: String, default: null },
        note: { type: String, default: null },
      },
    ],
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Asset', assetSchema);
