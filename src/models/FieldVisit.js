const mongoose = require('mongoose');
const { PROOF_STATUS } = require('../constants');

const geoPointSchema = new mongoose.Schema(
  { latitude: Number, longitude: Number, accuracy: Number, address: String },
  { _id: false }
);

const fieldVisitSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    workAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'FieldWorkAssignment', required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    checkInTime: { type: Date, default: null },
    checkInLocation: { type: geoPointSchema, default: null },
    checkOutTime: { type: Date, default: null },
    checkOutLocation: { type: geoPointSchema, default: null },
    selfie: { type: String, default: null },
    photos: [{ type: String }],
    clientSignature: { type: String, default: null },
    remarks: { type: String, default: null },
    totalWorkMinutes: { type: Number, default: 0 },
    distanceMeters: { type: Number, default: 0 }, // distance from client at check-in
    status: { type: String, enum: ['checked_in', 'checked_out'], default: 'checked_in' },
    // geo-fence approval (when check-in happened outside radius with a reason)
    approvalStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    outsideReason: { type: String, default: null },
    approvalActionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvalActionAt: { type: Date, default: null },
    // proof verification
    proofStatus: { type: String, enum: [...PROOF_STATUS, null], default: null },
    proofActionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    proofActionAt: { type: Date, default: null },
    proofRejectReason: { type: String, default: null },
  },
  { timestamps: true }
);

fieldVisitSchema.index({ companyId: 1, employeeId: 1, date: 1 });

module.exports = mongoose.model('FieldVisit', fieldVisitSchema);
