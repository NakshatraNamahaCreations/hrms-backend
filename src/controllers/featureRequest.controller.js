const FeatureRequest = require('../models/FeatureRequest');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { notify } = require('../services/notification.service');
const User = require('../models/User');
const { ROLES, FEATURE_REQUEST_TRANSITIONS } = require('../constants');

// POST /feature-requests (company_admin)
const createRequest = asyncHandler(async (req, res) => {
  const { title, description, featureKey } = req.body;
  if (!title || !description) throw new ApiError(400, 'title and description are required');
  const doc = await FeatureRequest.create({
    companyId: req.user.companyId,
    title,
    description,
    featureKey: featureKey || null,
    requestedBy: req.user.userId,
    statusHistory: [{ status: 'requested', by: req.user.userId }],
  });
  // notify platform owner(s)
  const owners = await User.find({ role: ROLES.SUPER_ADMIN, isActive: true }).select('_id').lean();
  await notify({
    userIds: owners.map((o) => o._id),
    title: 'New feature request',
    message: `${title} — requested by a company`,
    type: 'feature_request',
    meta: { featureRequestId: doc._id },
  });
  return created(res, doc, 'Feature request submitted');
});

// GET /feature-requests
const listRequests = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.SUPER_ADMIN) {
    if (req.query.companyId) filter.companyId = req.query.companyId;
  } else {
    filter.companyId = req.user.companyId;
  }
  if (req.query.status) filter.status = req.query.status;
  const { items, pagination } = await paginate(req.query, FeatureRequest, filter, {
    searchFields: ['title'],
    populate: [{ path: 'companyId', select: 'name code' }, { path: 'requestedBy', select: 'name email' }],
  });
  return ok(res, items, 'Feature requests', pagination);
});

// GET /feature-requests/:id
const getRequest = asyncHandler(async (req, res) => {
  const filter = { _id: req.params.id };
  if (req.user.role !== ROLES.SUPER_ADMIN) filter.companyId = req.user.companyId;
  const doc = await FeatureRequest.findOne(filter)
    .populate('companyId', 'name code')
    .populate('requestedBy', 'name email');
  if (!doc) throw new ApiError(404, 'Feature request not found');
  return ok(res, doc, 'Feature request detail');
});

// PATCH /feature-requests/:id/status (super_admin) { status, quoteAmount?, estimatedDays?, assignee?, ownerNotes?, note? }
const updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const doc = await FeatureRequest.findById(req.params.id);
  if (!doc) throw new ApiError(404, 'Feature request not found');

  const allowed = FEATURE_REQUEST_TRANSITIONS[doc.status] || [];
  if (!allowed.includes(status)) {
    throw new ApiError(400, `Cannot move feature request from '${doc.status}' to '${status}'. Allowed: ${allowed.join(', ') || 'none'}`);
  }
  doc.status = status;
  if (req.body.quoteAmount !== undefined) doc.quoteAmount = req.body.quoteAmount;
  if (req.body.estimatedDays !== undefined) doc.estimatedDays = req.body.estimatedDays;
  if (req.body.assignee !== undefined) doc.assignee = req.body.assignee;
  if (req.body.ownerNotes !== undefined) doc.ownerNotes = req.body.ownerNotes;
  doc.statusHistory.push({ status, by: req.user.userId, note: req.body.note || null });
  await doc.save();

  await notify({
    companyId: doc.companyId,
    userId: doc.requestedBy,
    title: 'Feature request update',
    message: `Your feature request "${doc.title}" is now '${status}'${doc.quoteAmount ? ` (quote: ₹${doc.quoteAmount})` : ''}.`,
    type: 'feature_request',
    meta: { featureRequestId: doc._id },
  });
  return ok(res, doc, 'Feature request status updated');
});

module.exports = { createRequest, listRequests, getRequest, updateStatus };
