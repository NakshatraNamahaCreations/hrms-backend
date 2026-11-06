const mongoose = require('mongoose');
const { CANDIDATE_STATUS } = require('../constants');

const candidateSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentJob', required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: null },
    resume: { type: String, default: null },
    currentCompany: { type: String, default: null },
    experienceYears: { type: Number, default: 0 },
    expectedSalary: { type: Number, default: null },
    status: { type: String, enum: CANDIDATE_STATUS, default: 'applied' },
    interviewDate: { type: Date, default: null },
    rating: { type: Number, min: 0, max: 5, default: null },
    notes: [
      {
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: String,
        at: { type: Date, default: Date.now },
      },
    ],
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

candidateSchema.index({ companyId: 1, jobId: 1, status: 1 });

module.exports = mongoose.model('Candidate', candidateSchema);
