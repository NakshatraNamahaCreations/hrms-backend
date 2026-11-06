const dayjs = require('dayjs');
const AttendanceCorrection = require('../models/AttendanceCorrection');
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { logAudit } = require('../middleware/audit');
const { notify } = require('../services/notification.service');
const payrollService = require('../services/payroll.service');
const { ROLES } = require('../constants');

const POPULATE = [{ path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName userId job.managerId' }];

// POST /attendance/corrections — employee submits
const createCorrection = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const { date, requestedCheckIn, requestedCheckOut, requestedStatus, reason } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'date (YYYY-MM-DD) is required');
  if (!reason) throw new ApiError(400, 'reason is required');
  if (!requestedCheckIn && !requestedCheckOut && !requestedStatus) {
    throw new ApiError(400, 'Provide at least one of requestedCheckIn, requestedCheckOut or requestedStatus');
  }
  const d = dayjs(date);
  if (await payrollService.isMonthLocked(req.user.companyId, d.month() + 1, d.year())) {
    throw new ApiError(423, `Attendance for ${d.format('MMMM YYYY')} is locked (payroll finalized)`);
  }

  const pendingExists = await AttendanceCorrection.exists({
    companyId: req.user.companyId,
    employeeId: req.user.employeeId,
    date,
    status: { $in: ['pending', 'manager_approved'] },
  });
  if (pendingExists) throw new ApiError(409, 'A correction request for this date is already in progress');

  const doc = await AttendanceCorrection.create({
    companyId: req.user.companyId,
    employeeId: req.user.employeeId,
    date,
    requestedCheckIn: requestedCheckIn ? new Date(requestedCheckIn) : null,
    requestedCheckOut: requestedCheckOut ? new Date(requestedCheckOut) : null,
    requestedStatus: requestedStatus || null,
    reason,
  });

  // notify manager
  const employee = await Employee.findById(req.user.employeeId).select('job.managerId').lean();
  if (employee && employee.job && employee.job.managerId) {
    const manager = await Employee.findById(employee.job.managerId).select('userId').lean();
    if (manager && manager.userId) {
      await notify({
        companyId: req.user.companyId,
        userId: manager.userId,
        title: 'Attendance correction request',
        message: `${req.user.name} requested an attendance correction for ${date}.`,
        type: 'attendance_correction',
        meta: { correctionId: doc._id },
      });
    }
  }
  return created(res, doc, 'Correction request submitted');
});

// GET /attendance/corrections — list (role-scoped)
const listCorrections = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.status) filter.status = req.query.status;
  const { items, pagination } = await paginate(req.query, AttendanceCorrection, filter, {
    searchFields: ['date', 'reason', 'status'],
    sortable: ['date', 'status', 'createdAt', 'updatedAt'],
    populate: POPULATE,
  });
  return ok(res, items, 'Correction requests', pagination);
});

// GET /attendance/corrections/pending — pending for the current approver
const pendingForApprover = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if (req.user.role === ROLES.MANAGER) {
    const team = await Employee.find({ companyId, 'job.managerId': req.user.employeeId, isDeleted: false }).select('_id').lean();
    filter.employeeId = { $in: team.map((t) => t._id) };
    filter.status = 'pending';
  } else {
    // hr/company admin verify after manager approval
    filter.status = { $in: ['pending', 'manager_approved'] };
  }
  const { items, pagination } = await paginate(req.query, AttendanceCorrection, filter, {
    searchFields: ['date', 'reason', 'status'],
    sortable: ['date', 'status', 'createdAt', 'updatedAt'],
    populate: POPULATE,
  });
  return ok(res, items, 'Pending correction requests', pagination);
});

// PATCH /attendance/corrections/:id/approve — manager step
const managerApprove = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const doc = await AttendanceCorrection.findOne({ _id: req.params.id, companyId });
  if (!doc) throw new ApiError(404, 'Correction request not found');
  if (doc.status !== 'pending') throw new ApiError(400, `Request is '${doc.status}', expected 'pending'`);
  doc.status = 'manager_approved';
  doc.managerActionBy = req.user.userId;
  doc.managerActionAt = new Date();
  await doc.save();
  return ok(res, doc, 'Correction approved by manager — awaiting HR verification');
});

// PATCH /attendance/corrections/:id/verify — HR step: upsert attendance
const hrVerify = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const doc = await AttendanceCorrection.findOne({ _id: req.params.id, companyId }).populate(POPULATE);
  if (!doc) throw new ApiError(404, 'Correction request not found');
  if (!['pending', 'manager_approved'].includes(doc.status)) {
    throw new ApiError(400, `Request is '${doc.status}' and cannot be verified`);
  }
  const d = dayjs(doc.date);
  if (await payrollService.isMonthLocked(companyId, d.month() + 1, d.year())) {
    throw new ApiError(423, `Attendance for ${d.format('MMMM YYYY')} is locked (payroll finalized)`);
  }

  const update = { attendanceSource: 'admin_correction', markedBy: req.user.userId, remarks: `Correction: ${doc.reason}` };
  if (doc.requestedCheckIn) update.checkIn = { time: doc.requestedCheckIn, source: 'admin_correction' };
  if (doc.requestedCheckOut) update.checkOut = { time: doc.requestedCheckOut, source: 'admin_correction' };
  if (doc.requestedStatus) update.status = doc.requestedStatus;
  if (doc.requestedCheckIn && doc.requestedCheckOut) {
    const workMinutes = Math.max(Math.round((new Date(doc.requestedCheckOut) - new Date(doc.requestedCheckIn)) / 60000), 0);
    update.workMinutes = workMinutes;
    update.totalHours = Math.round((workMinutes / 60) * 100) / 100;
    if (!update.status) update.status = 'present';
  }

  const employeeId = doc.employeeId._id || doc.employeeId;
  const attendance = await Attendance.findOneAndUpdate(
    { companyId, employeeId, date: doc.date },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  doc.status = 'approved';
  doc.hrActionBy = req.user.userId;
  doc.hrActionAt = new Date();
  await doc.save();

  logAudit(req, {
    action: 'attendance.correction_applied',
    entityType: 'Attendance',
    entityId: attendance._id,
    meta: { correctionId: doc._id, date: doc.date },
  });

  if (doc.employeeId.userId) {
    await notify({
      companyId,
      userId: doc.employeeId.userId,
      title: 'Attendance correction approved',
      message: `Your attendance correction for ${doc.date} has been applied.`,
      type: 'attendance_correction',
    });
  }
  return ok(res, { correction: doc, attendance }, 'Correction verified and attendance updated');
});

// PATCH /attendance/corrections/:id/reject
const rejectCorrection = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const doc = await AttendanceCorrection.findOne({ _id: req.params.id, companyId }).populate(POPULATE);
  if (!doc) throw new ApiError(404, 'Correction request not found');
  if (!['pending', 'manager_approved'].includes(doc.status)) {
    throw new ApiError(400, `Request is '${doc.status}' and cannot be rejected`);
  }
  doc.status = 'rejected';
  doc.rejectionReason = req.body.reason || null;
  if (req.user.role === ROLES.MANAGER) {
    doc.managerActionBy = req.user.userId;
    doc.managerActionAt = new Date();
  } else {
    doc.hrActionBy = req.user.userId;
    doc.hrActionAt = new Date();
  }
  await doc.save();
  if (doc.employeeId.userId) {
    await notify({
      companyId,
      userId: doc.employeeId.userId,
      title: 'Attendance correction rejected',
      message: `Your attendance correction for ${doc.date} was rejected${req.body.reason ? `: ${req.body.reason}` : '.'}`,
      type: 'attendance_correction',
    });
  }
  return ok(res, doc, 'Correction request rejected');
});

module.exports = { createCorrection, listCorrections, pendingForApprover, managerApprove, hrVerify, rejectCorrection };
