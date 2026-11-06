const dayjs = require('dayjs');
const Resignation = require('../models/Resignation');
const Employee = require('../models/Employee');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { notify, notifyRoles } = require('../services/notification.service');
const { logAudit } = require('../middleware/audit');
const { generateLetterForEmployee } = require('./document.controller');
const { ROLES } = require('../constants');

const POPULATE = [
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName userId job.managerId' },
  { path: 'managerActionBy', select: 'name' },
  { path: 'hrActionBy', select: 'name' },
];

// POST /exits — employee applies
const applyResignation = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  if (!req.body.reason) throw new ApiError(400, 'reason is required');

  const existing = await Resignation.exists({
    companyId,
    employeeId: req.user.employeeId,
    status: { $nin: ['rejected', 'withdrawn', 'completed'] },
  });
  if (existing) throw new ApiError(409, 'You already have an active resignation request');

  const noticePeriodDays = req.body.noticePeriodDays != null ? Number(req.body.noticePeriodDays) : 30;
  const resignation = await Resignation.create({
    companyId,
    employeeId: req.user.employeeId,
    reason: req.body.reason,
    resignationDate: new Date(),
    noticePeriodDays,
    lastWorkingDate: req.body.lastWorkingDate
      ? new Date(req.body.lastWorkingDate)
      : dayjs().add(noticePeriodDays, 'day').toDate(),
  });

  // notify manager
  const employee = await Employee.findById(req.user.employeeId).select('job.managerId').lean();
  if (employee && employee.job && employee.job.managerId) {
    const manager = await Employee.findById(employee.job.managerId).select('userId').lean();
    if (manager && manager.userId) {
      await notify({
        companyId,
        userId: manager.userId,
        title: 'Resignation submitted',
        message: `${req.user.name} has submitted a resignation request.`,
        type: 'exit',
        meta: { resignationId: resignation._id },
      });
    }
  }
  return created(res, resignation, 'Resignation submitted');
});

// GET /exits
const listResignations = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
  } else if (req.user.role === ROLES.MANAGER && req.user.employeeId) {
    const team = await Employee.find({ companyId, 'job.managerId': req.user.employeeId, isDeleted: false }).select('_id').lean();
    filter.employeeId = { $in: [...team.map((t) => t._id), req.user.employeeId] };
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.status) filter.status = req.query.status;
  const { items, pagination } = await paginate(req.query, Resignation, filter, {
    searchFields: ['reason', 'status'],
    sortable: ['createdAt', 'updatedAt', 'status', 'resignationDate', 'lastWorkingDate', 'noticePeriodDays'],
    populate: POPULATE,
  });
  return ok(res, items, 'Resignations', pagination);
});

// GET /exits/:id
const getResignation = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) filter.employeeId = req.user.employeeId;
  const resignation = await Resignation.findOne(filter).populate(POPULATE);
  if (!resignation) throw new ApiError(404, 'Resignation not found');
  return ok(res, resignation, 'Resignation detail');
});

// PATCH /exits/:id/manager-review  { action: 'approve' | 'reject', note? }
const managerReview = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) throw new ApiError(400, "action must be 'approve' or 'reject'");
  const resignation = await Resignation.findOne({ _id: req.params.id, companyId }).populate(POPULATE);
  if (!resignation) throw new ApiError(404, 'Resignation not found');
  if (resignation.status !== 'applied') throw new ApiError(400, `Resignation is '${resignation.status}', expected 'applied'`);

  resignation.status = action === 'approve' ? 'manager_approved' : 'rejected';
  resignation.managerActionBy = req.user.userId;
  resignation.managerActionAt = new Date();
  resignation.managerNote = req.body.note || null;
  if (action === 'reject') resignation.rejectionReason = req.body.note || null;
  await resignation.save();

  if (action === 'approve') {
    await notifyRoles({
      companyId,
      roles: [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN],
      title: 'Resignation needs HR review',
      message: `Resignation of ${resignation.employeeId.personal.firstName} approved by manager.`,
      type: 'exit',
      meta: { resignationId: resignation._id },
    });
  }
  if (resignation.employeeId.userId) {
    await notify({
      companyId,
      userId: resignation.employeeId.userId,
      title: `Resignation ${action === 'approve' ? 'approved by manager' : 'rejected'}`,
      message: `Your resignation was ${action === 'approve' ? 'approved by your manager and sent to HR' : 'rejected'}.`,
      type: 'exit',
    });
  }
  return ok(res, resignation, `Resignation ${action === 'approve' ? 'manager-approved' : 'rejected'}`);
});

// PATCH /exits/:id/hr-review  { action: 'approve' | 'reject', lastWorkingDate?, note? }
const hrReview = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) throw new ApiError(400, "action must be 'approve' or 'reject'");
  const resignation = await Resignation.findOne({ _id: req.params.id, companyId }).populate(POPULATE);
  if (!resignation) throw new ApiError(404, 'Resignation not found');
  if (resignation.status !== 'manager_approved') {
    throw new ApiError(400, `Resignation is '${resignation.status}', expected 'manager_approved'`);
  }

  resignation.status = action === 'approve' ? 'checklist_in_progress' : 'rejected';
  resignation.hrActionBy = req.user.userId;
  resignation.hrActionAt = new Date();
  resignation.hrNote = req.body.note || null;
  if (req.body.lastWorkingDate) resignation.lastWorkingDate = new Date(req.body.lastWorkingDate);
  if (action === 'reject') resignation.rejectionReason = req.body.note || null;
  await resignation.save();

  if (resignation.employeeId.userId) {
    await notify({
      companyId,
      userId: resignation.employeeId.userId,
      title: `Resignation ${action === 'approve' ? 'accepted' : 'rejected'} by HR`,
      message: action === 'approve'
        ? `Your resignation is accepted. Last working date: ${dayjs(resignation.lastWorkingDate).format('DD MMM YYYY')}. Exit checklist started.`
        : 'Your resignation was rejected by HR.',
      type: 'exit',
    });
  }
  return ok(res, resignation, `Resignation ${action === 'approve' ? 'accepted — checklist started' : 'rejected'}`);
});

// PATCH /exits/:id/checklist  { assetsReturned?, fnfSettled?, exitInterviewDone?, accessRevoked?, documentsHandedOver?, fnfAmount? }
const updateChecklist = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const resignation = await Resignation.findOne({ _id: req.params.id, companyId });
  if (!resignation) throw new ApiError(404, 'Resignation not found');
  if (resignation.status !== 'checklist_in_progress') {
    throw new ApiError(400, `Resignation is '${resignation.status}', expected 'checklist_in_progress'`);
  }
  if (Array.isArray(req.body.checklist)) {
    // full array form from the admin panel: [{ item, done }] (plain strings allowed)
    resignation.checklist = req.body.checklist
      .map((c) => (typeof c === 'string' ? { item: c, done: false } : { item: String(c.item || ''), done: !!c.done }))
      .filter((c) => c.item);
  } else {
    // legacy flat-key form: { assetsReturned: true, ... }
    const LEGACY_KEYS = {
      assetsReturned: 'Assets returned',
      fnfSettled: 'Full & final settled',
      exitInterviewDone: 'Exit interview done',
      accessRevoked: 'Access revoked',
      documentsHandedOver: 'Documents handed over',
    };
    for (const [key, label] of Object.entries(LEGACY_KEYS)) {
      if (typeof req.body[key] === 'boolean') {
        const entry = resignation.checklist.find((c) => c.item === label);
        if (entry) entry.done = req.body[key];
        else resignation.checklist.push({ item: label, done: req.body[key] });
      }
    }
  }
  if (req.body.fnfAmount != null) resignation.fnfAmount = Number(req.body.fnfAmount);
  await resignation.save();
  return ok(res, resignation, 'Exit checklist updated');
});

// POST /exits/:id/complete — finalize: employee inactive + experience letter
const completeExit = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const resignation = await Resignation.findOne({ _id: req.params.id, companyId }).populate(POPULATE);
  if (!resignation) throw new ApiError(404, 'Resignation not found');
  if (resignation.status !== 'checklist_in_progress') {
    throw new ApiError(400, `Resignation is '${resignation.status}', expected 'checklist_in_progress'`);
  }
  const pendingItems = (resignation.checklist || []).filter((c) => !c.done).map((c) => c.item);
  if (pendingItems.length) {
    throw new ApiError(400, `Complete all checklist items first. Pending: ${pendingItems.join(', ')}`);
  }

  const employeeId = resignation.employeeId._id;
  const employee = await Employee.findById(employeeId);
  employee.status = 'exited';
  employee.exitDate = resignation.lastWorkingDate || new Date();
  await employee.save();
  if (employee.userId) await User.findByIdAndUpdate(employee.userId, { $set: { isActive: false } });

  // generate experience letter
  const { doc } = await generateLetterForEmployee({
    companyId,
    employeeId,
    letterType: 'experience',
    userId: req.user.userId,
    extra: { lastWorkingDate: resignation.lastWorkingDate },
  });

  resignation.status = 'completed';
  resignation.completedAt = new Date();
  resignation.completedBy = req.user.userId;
  resignation.experienceLetterDocumentId = doc._id;
  await resignation.save();

  logAudit(req, { action: 'exit.complete', entityType: 'Resignation', entityId: resignation._id, meta: { employeeId } });
  return ok(res, { resignation, experienceLetter: doc }, 'Exit completed — employee deactivated and experience letter generated');
});

// POST /exits/:id/approve | /exits/:id/reject — stage-aware dispatch used by the admin panel:
// acts as manager review while the resignation is 'applied', as HR review once 'manager_approved'.
const reviewDispatch = (action) =>
  asyncHandler(async (req, res, next) => {
    const companyId = getCompanyId(req);
    const resignation = await Resignation.findOne({ _id: req.params.id, companyId }).select('status');
    if (!resignation) throw new ApiError(404, 'Resignation not found');
    req.body = { ...req.body, action, note: req.body.note || req.body.comment || null };
    if (resignation.status === 'applied') return managerReview(req, res, next);
    if (resignation.status === 'manager_approved') {
      if (![ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN].includes(req.user.role)) {
        throw new ApiError(403, 'Only HR can act on a manager-approved resignation');
      }
      return hrReview(req, res, next);
    }
    throw new ApiError(400, `Resignation is '${resignation.status}' — nothing to ${action}`);
  });

const approveResignation = reviewDispatch('approve');
const rejectResignation = reviewDispatch('reject');

// PATCH /exits/:id/withdraw — employee withdraws own request
const withdrawResignation = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const resignation = await Resignation.findOne({ _id: req.params.id, companyId, employeeId: req.user.employeeId });
  if (!resignation) throw new ApiError(404, 'Resignation not found');
  if (!['applied', 'manager_approved'].includes(resignation.status)) {
    throw new ApiError(400, `Resignation is '${resignation.status}' and cannot be withdrawn`);
  }
  resignation.status = 'withdrawn';
  await resignation.save();
  return ok(res, resignation, 'Resignation withdrawn');
});

module.exports = {
  applyResignation,
  listResignations,
  getResignation,
  managerReview,
  hrReview,
  approveResignation,
  rejectResignation,
  updateChecklist,
  completeExit,
  withdrawResignation,
};
