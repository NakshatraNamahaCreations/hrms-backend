const mongoose = require('mongoose');
const { ASSIGNMENT_STATUS } = require('../constants');

const courseAssignmentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: ASSIGNMENT_STATUS, default: 'assigned' },
    completedAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

courseAssignmentSchema.index({ courseId: 1, employeeId: 1 }, { unique: true });
courseAssignmentSchema.index({ companyId: 1, employeeId: 1, status: 1 });

module.exports = mongoose.model('CourseAssignment', courseAssignmentSchema);
