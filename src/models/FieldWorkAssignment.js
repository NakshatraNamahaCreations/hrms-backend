const mongoose = require('mongoose');
const { WORK_ASSIGNMENT_STATUS } = require('../constants');

const checklistItemSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    // Which team member owns this task (null = unassigned / whole team).
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  },
  { _id: true }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: WORK_ASSIGNMENT_STATUS },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, default: null },
  },
  { _id: false }
);

// A job is worked by a TEAM. Each member has a role and tracks their own
// check-in/out days, which drive their day-wise cost and profit share.
const assigneeSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    role: { type: String, default: null, trim: true }, // free text: "Project Manager", "Designer"…
    employeeType: { type: String, default: null }, // 'office_employee' | 'field_employee' (snapshot)
    status: { type: String, enum: ['assigned', 'in_progress', 'completed'], default: 'assigned' },
    workDays: { type: [String], default: [] }, // distinct YYYY-MM-DD this member checked in on the job
    checkInAt: { type: Date, default: null }, // active check-in (cleared on check-out)
    checkOutAt: { type: Date, default: null },
    lastLocation: { latitude: Number, longitude: Number },
    distanceMeters: { type: Number, default: null }, // distance to job pin at last check-in (field members)
    daysOverride: { type: Number, default: null }, // company_admin manual day count
    // costing snapshot (company_admin only; recomputed on demand / completion)
    dailyCost: { type: Number, default: 0 },
    daysWorked: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    profit: { type: Number, default: 0 }, // attributed by cost share
  },
  { _id: true }
);

const fieldWorkAssignmentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: false, default: null },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    instructions: { type: String, default: null },
    date: { type: String, required: true }, // YYYY-MM-DD
    startTime: { type: String, default: null }, // "HH:mm"
    endTime: { type: String, default: null },
    expectedDurationMinutes: { type: Number, default: null },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    checklist: { type: [checklistItemSchema], default: [] },
    attachments: { type: [String], default: [] },
    status: { type: String, enum: WORK_ASSIGNMENT_STATUS, default: 'assigned' },
    statusHistory: [statusHistorySchema],
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientLocation: { latitude: Number, longitude: Number, address: String },
    rejectReason: { type: String, default: null },
    cancelReason: { type: String, default: null },
    rescheduledTo: { type: String, default: null }, // YYYY-MM-DD

    // Job team. employeeId above stays as the "primary" member (1st assignee) for
    // backward compatibility with the existing single-employee check-in flow.
    assignees: { type: [assigneeSchema], default: [] },

    // --- Profitability (visible to company_admin only) -------------------------
    jobValue: { type: Number, default: 0 }, // ₹ — editable
    // Optional manual override for days worked; when null we auto-count from status history.
    daysWorkedOverride: { type: Number, default: null },
    // Snapshot of the profit math, recomputed on completion.
    costing: {
      dailyCost: { type: Number, default: 0 },
      daysWorked: { type: Number, default: 0 },
      laborCost: { type: Number, default: 0 },
      profit: { type: Number, default: 0 },
      margin: { type: Number, default: 0 }, // %
      computedAt: { type: Date, default: null },
    },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

fieldWorkAssignmentSchema.index({ companyId: 1, employeeId: 1, date: 1 });
fieldWorkAssignmentSchema.index({ companyId: 1, date: 1, status: 1 });

module.exports = mongoose.model('FieldWorkAssignment', fieldWorkAssignmentSchema);
