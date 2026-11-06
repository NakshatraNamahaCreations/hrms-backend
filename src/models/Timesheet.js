const mongoose = require('mongoose');
const { TIMESHEET_STATUS } = require('../constants');

const timesheetSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    // Optional: which task the hours went against, so estimates can be tracked.
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    date: { type: String, required: true }, // YYYY-MM-DD
    hours: { type: Number, required: true, min: 0.5, max: 24 },
    note: { type: String, default: null },
    billable: { type: Boolean, default: false },
    status: { type: String, enum: TIMESHEET_STATUS, default: 'submitted' },
    actionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actionAt: { type: Date, default: null },
  },
  { timestamps: true }
);

timesheetSchema.index({ companyId: 1, projectId: 1, date: 1 });
timesheetSchema.index({ companyId: 1, employeeId: 1, date: 1 });

module.exports = mongoose.model('Timesheet', timesheetSchema);
