const mongoose = require('mongoose');
const { TASK_STATUS } = require('../constants');

const taskSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    dueDate: { type: Date, default: null },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    status: { type: String, enum: TASK_STATUS, default: 'todo' },
    completedAt: { type: Date, default: null },
    comments: [
      {
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: String,
        message: String,
        at: { type: Date, default: Date.now },
      },
    ],
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

taskSchema.index({ companyId: 1, assignedTo: 1, status: 1 });

module.exports = mongoose.model('Task', taskSchema);
