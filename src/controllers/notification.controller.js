const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok } = require('../utils/ApiResponse');
const { notify } = require('../services/notification.service');

const SEND_TYPES = ['general', 'announcement', 'alert', 'reminder'];

// Server-side caps for admin-composed notifications: the body parser accepts
// up to 5 MB and all:true duplicates the message into one Notification
// document PER USER (insertMany), so an uncapped payload could fan out
// megabytes into every user document. Mirrors the UI's 150-char title limit.
const MAX_TITLE_LENGTH = 150;
const MAX_MESSAGE_LENGTH = 2000;

// GET /notifications — own; ?isRead=true|false filter
const listNotifications = asyncHandler(async (req, res) => {
  const filter = { userId: req.user.userId };
  if (req.query.unread === 'true') filter.isRead = false;
  if (req.query.isRead === 'true') filter.isRead = true;
  else if (req.query.isRead === 'false') filter.isRead = false;
  const { items, pagination } = await paginate(req.query, Notification, filter, {
    searchFields: ['title', 'message', 'type'],
    sortable: ['createdAt', 'type', 'isRead'],
    sort: { createdAt: -1 },
  });
  const unreadCount = await Notification.countDocuments({ userId: req.user.userId, isRead: false });
  return ok(res, { items, unreadCount }, 'Notifications', pagination);
});

// PATCH /notifications/:id/read
const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.userId },
    { $set: { isRead: true, readAt: new Date() } },
    { new: true }
  );
  if (!notification) throw new ApiError(404, 'Notification not found');
  return ok(res, notification, 'Notification marked as read');
});

// PATCH /notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  const result = await Notification.updateMany(
    { userId: req.user.userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
  return ok(res, { updated: result.modifiedCount }, 'All notifications marked as read');
});

// POST /notifications/send — admin composes a notification to employees.
// Body: { employeeIds?: [id], all?: true, title, message, type?, email? }
const sendNotification = asyncHandler(async (req, res) => {
  const { employeeIds, all, title, message, type = 'general', email } = req.body || {};
  const trimmedTitle = title === undefined || title === null ? '' : String(title).trim();
  const trimmedMessage = message === undefined || message === null ? '' : String(message).trim();
  if (!trimmedTitle) throw new ApiError(400, 'title is required');
  if (!trimmedMessage) throw new ApiError(400, 'message is required');
  if (trimmedTitle.length > MAX_TITLE_LENGTH) {
    throw new ApiError(400, `title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    throw new ApiError(400, `message must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  if (!SEND_TYPES.includes(type)) {
    throw new ApiError(400, `type must be one of: ${SEND_TYPES.join(', ')}`);
  }

  // super_admin (no companyId on the token) may target a company explicitly
  const companyId = req.user.companyId || req.body.companyId || null;
  if (!companyId) throw new ApiError(400, 'companyId is required');

  // Resolve targets: all active non-deleted employees of the company, or the
  // given employeeIds (company scoping validates they belong to the company).
  const filter = { companyId, isDeleted: false, status: 'active' };
  if (all !== true) {
    const ids = (Array.isArray(employeeIds) ? employeeIds : []).filter((id) => mongoose.isValidObjectId(id));
    if (!ids.length) throw new ApiError(400, 'Provide employeeIds or all: true');
    filter._id = { $in: ids };
  }
  const employees = await Employee.find(filter).select('_id').lean();
  if (!employees.length) throw new ApiError(400, 'No valid target employees found');
  const targeted = employees.length;

  // Map employees → their login accounts; skip (and count) those without one.
  const users = await User.find({
    companyId,
    employeeId: { $in: employees.map((e) => e._id) },
    isActive: true,
  }).select('_id employeeId').lean();
  const withAccount = new Set(users.map((u) => String(u.employeeId)));
  const skippedNoAccount = targeted - withAccount.size;
  if (!users.length) throw new ApiError(400, 'None of the selected employees have a login account');

  const docs = await notify({
    companyId,
    userIds: users.map((u) => u._id),
    title: trimmedTitle,
    message: trimmedMessage,
    type,
    channels: email ? ['email'] : [],
  });

  return ok(res, { sent: docs.length, skippedNoAccount, targeted }, 'Notification sent');
});

// POST /notifications/register-device  { fcmToken?, deviceId? } — mobile push registration
const registerDevice = asyncHandler(async (req, res) => {
  const { fcmToken, deviceId } = req.body;
  if (!fcmToken && !deviceId) throw new ApiError(400, 'fcmToken or deviceId is required');
  const update = {};
  if (fcmToken) update.fcmToken = fcmToken;
  if (deviceId) update.deviceId = deviceId;
  await User.updateOne({ _id: req.user.userId }, { $set: update });
  return ok(res, update, 'Device registered for notifications');
});

module.exports = { listNotifications, sendNotification, markRead, markAllRead, registerDevice };
