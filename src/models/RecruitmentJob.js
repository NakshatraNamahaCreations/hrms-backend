const mongoose = require('mongoose');

const recruitmentJobSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    title: { type: String, required: true, trim: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    designationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation', default: null },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    description: { type: String, default: '' },
    openings: { type: Number, default: 1, min: 1 },
    employmentType: {
      type: String,
      enum: ['full_time', 'part_time', 'contract', 'intern'],
      default: 'full_time',
    },
    salaryRange: { min: Number, max: Number },
    skills: [{ type: String }],
    status: { type: String, enum: ['open', 'on_hold', 'closed'], default: 'open' },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closingDate: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RecruitmentJob', recruitmentJobSchema);
