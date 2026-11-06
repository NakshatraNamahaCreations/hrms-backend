const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    audience: { type: String, enum: ['all', 'department', 'branch'], default: 'all' },
    departmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department' }],
    branchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    publishAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    attachment: { type: String, default: null },
    pinned: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Announcement', announcementSchema);
