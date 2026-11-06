const dayjs = require('dayjs');
const IncrementRequest = require('../models/IncrementRequest');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isAdminRole } = require('../utils/scope');
const { notify, notifyRoles } = require('../services/notification.service');
const { logAudit } = require('../middleware/audit');
const { generateLetterForEmployee } = require('./document.controller');
const { ROLES } = require('../constants');

const POPULATE = [
  {
    path: 'employeeId',
    select: 'employeeCode personal.firstName personal.lastName userId job.designationId',
    populate: { path: 'job.designationId', select: 'name' },
  },
  { path: 'actionBy', select: 'name' },
];

const OPEN_STATUSES = ['requested', 'under_review'];

const canAdminister = (role) => isAdminRole(role) || role === ROLES.PAYROLL_ADMIN;

// POST /increments — employee/field requests a salary revision for self
const submitRequest = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const requestedCtc = Number(req.body.requestedCtc);
  if (!requestedCtc || requestedCtc <= 0) throw new ApiError(400, 'A positive requestedCtc is required');
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');

  const employee = await Employee.findOne({ _id: req.user.employeeId, companyId, isDeleted: false, status: 'active' });
  if (!employee) throw new ApiError(400, 'No employee profile linked to your account');

  const open = await IncrementRequest.exists({
    companyId,
    employeeId: employee._id,
    status: { $in: OPEN_STATUSES },
  });
  if (open) throw new ApiError(409, 'You already have an open increment request');

  const request = await IncrementRequest.create({
    companyId,
    employeeId: employee._id,
    currentCtc: (employee.salary && employee.salary.ctc) || 0,
    requestedCtc,
    reason: req.body.reason || null,
  });
  res.locals.auditEntityId = request._id;

  await notifyRoles({
    companyId,
    roles: [ROLES.HR_ADMIN, ROLES.PAYROLL_ADMIN, ROLES.COMPANY_ADMIN],
    title: 'Increment request submitted',
    message: `${req.user.name} has requested an increment: ₹${request.currentCtc} → ₹${request.requestedCtc}.`,
    type: 'increment',
    meta: { incrementRequestId: request._id },
  });
  return created(res, request, 'Increment request submitted');
});

// GET /increments — HR/payroll/company admins see all (with filters); others see own history
const listRequests = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if (!canAdminister(req.user.role)) {
    filter.employeeId = req.user.employeeId;
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.status) filter.status = req.query.status;
  const { items, pagination } = await paginate(req.query, IncrementRequest, filter, {
    searchFields: ['status', 'reason'],
    sortable: ['createdAt', 'updatedAt', 'status', 'currentCtc', 'requestedCtc'],
    populate: POPULATE,
  });
  return ok(res, items, 'Increment requests', pagination);
});

const loadRequest = async (req, expectedStatus) => {
  const companyId = getCompanyId(req);
  const request = await IncrementRequest.findOne({ _id: req.params.id, companyId })
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName userId');
  if (!request) throw new ApiError(404, 'Increment request not found');
  if (!expectedStatus.includes(request.status)) {
    throw new ApiError(400, `Increment request is '${request.status}', expected one of: ${expectedStatus.join(', ')}`);
  }
  return request;
};

const notifyEmployee = async (companyId, request, title, message) => {
  if (request.employeeId && request.employeeId.userId) {
    await notify({
      companyId,
      userId: request.employeeId.userId,
      title,
      message,
      type: 'increment',
      meta: { incrementRequestId: request._id },
    });
  }
};

// PATCH /increments/:id/under-review
const markUnderReview = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const request = await loadRequest(req, ['requested']);
  request.status = 'under_review';
  request.actionBy = req.user.userId;
  request.actionAt = new Date();
  await request.save();
  await notifyEmployee(companyId, request, 'Increment request under review',
    `Your increment request (₹${request.currentCtc} → ₹${request.requestedCtc}) is now under review.`);
  logAudit(req, { action: 'increment.under_review', entityType: 'IncrementRequest', entityId: request._id });
  return ok(res, request, 'Increment request under review');
});

// PATCH /increments/:id/approve  { note?, generateLetter?, effectiveDate?, updateSalary? }
const approveRequest = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const request = await loadRequest(req, OPEN_STATUSES);
  const generateLetter = req.body.generateLetter === true;
  const updateSalary = req.body.updateSalary === true;
  const effectiveDate = req.body.effectiveDate || new Date();
  const incrementPercent = request.currentCtc > 0
    ? Math.round(((request.requestedCtc - request.currentCtc) / request.currentCtc) * 10000) / 100
    : null;

  request.status = 'approved';
  request.reviewNote = req.body.note || null;
  request.actionBy = req.user.userId;
  request.actionAt = new Date();
  await request.save();

  // increment letter via the letter engine (failure must not block the approval)
  let letter = null;
  if (generateLetter) {
    try {
      const result = await generateLetterForEmployee({
        companyId,
        employeeId: request.employeeId._id,
        letterType: 'increment',
        userId: req.user.userId,
        extra: {
          currentCtc: request.currentCtc,
          newCtc: request.requestedCtc,
          effectiveDate,
          incrementPercent,
        },
      });
      letter = result.doc;
    } catch (e) {
      /* letter generation is best-effort */
    }
  }

  if (updateSalary) {
    const employee = await Employee.findOne({ _id: request.employeeId._id, companyId });
    if (!employee) throw new ApiError(404, 'Employee not found');
    const oldCtc = employee.salary.ctc;
    employee.salary.ctc = request.requestedCtc;
    await employee.save();
    logAudit(req, {
      action: 'employee.salary_change',
      entityType: 'Employee',
      entityId: employee._id,
      meta: { oldCtc, newCtc: employee.salary.ctc, letterType: 'increment', effectiveDate },
    });
  }

  await notifyEmployee(companyId, request, 'Increment request approved',
    `Congratulations! Your increment request has been approved — revised CTC ₹${request.requestedCtc}, effective ${dayjs(effectiveDate).format('DD MMM YYYY')}.`);
  logAudit(req, {
    action: 'increment.approve',
    entityType: 'IncrementRequest',
    entityId: request._id,
    meta: { requestedCtc: request.requestedCtc, generateLetter, updateSalary, effectiveDate },
  });
  return ok(res, { request, letter }, 'Increment request approved');
});

// PATCH /increments/:id/reject  { note }
const rejectRequest = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  if (!req.body.note) throw new ApiError(400, 'note is required to reject an increment request');
  const request = await loadRequest(req, OPEN_STATUSES);
  request.status = 'rejected';
  request.reviewNote = req.body.note;
  request.actionBy = req.user.userId;
  request.actionAt = new Date();
  await request.save();
  await notifyEmployee(companyId, request, 'Increment request rejected',
    `Your increment request (₹${request.currentCtc} → ₹${request.requestedCtc}) was rejected: ${req.body.note}`);
  logAudit(req, { action: 'increment.reject', entityType: 'IncrementRequest', entityId: request._id, meta: { note: req.body.note } });
  return ok(res, request, 'Increment request rejected');
});

module.exports = { submitRequest, listRequests, markUnderReview, approveRequest, rejectRequest };
