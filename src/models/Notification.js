const mongoose = require('mongoose');

// Backstop length caps (admin compose enforces tighter limits at the API):
// notifications are fanned out as one document PER USER, so unbounded
// title/message would be duplicated N times. notification.service truncates
// to these bounds before insert so internal callers never throw on length.
const MAX_TITLE_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 5000;

const notificationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, maxlength: MAX_TITLE_LENGTH },
    message: { type: String, required: true, maxlength: MAX_MESSAGE_LENGTH },
    type: { type: String, default: 'general' },
    link: { type: String, default: null },
    meta: { type: Object, default: {} },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.MAX_TITLE_LENGTH = MAX_TITLE_LENGTH;
module.exports.MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;
