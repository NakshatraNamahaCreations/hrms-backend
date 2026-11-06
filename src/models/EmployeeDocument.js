const mongoose = require('mongoose');
const { DOCUMENT_STATUS, LETTER_TYPES } = require('../constants');

const employeeDocumentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    type: { type: String, default: 'other' }, // aadhaar | pan | resume | certificate | letter | other
    title: { type: String, required: true },
    fileUrl: { type: String, default: null },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: 0 }, // bytes (from multer)
    status: { type: String, enum: DOCUMENT_STATUS, default: 'pending' },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isGenerated: { type: Boolean, default: false },
    letterType: { type: String, enum: [...LETTER_TYPES, null], default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

employeeDocumentSchema.index({ companyId: 1, employeeId: 1 });

module.exports = mongoose.model('EmployeeDocument', employeeDocumentSchema);
