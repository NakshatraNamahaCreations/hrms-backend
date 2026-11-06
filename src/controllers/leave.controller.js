const dayjs = require('dayjs');
const mongoose = require('mongoose');
const Leave = require('../models/Leave');
const LeaveBalance = require('../models/LeaveBalance');
const Employee = require('../models/Employee');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { paginateArray } = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { notify } = require('../services/notification.service');
const { ROLES, LEAVE_TYPES } = require('../constants');

const POPULATE = [
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName userId job.managerId' },
  { path: 'approvedBy', select: 'name' },
];

// Ensures a LeaveBalance doc exists for the year (auto-init from company policy).
const ensureBalance = async (companyId, employeeId, year) => {
  let balance = await LeaveBalance.findOne({ companyId, employeeId, year });
  if (!balance) {
    const company = await Company.findById(companyId).select('settings.leavePolicy').lean();
    const policy = (company && company.settings && company.settings.leavePolicy) || { casual: 12, sick: 8, earned: 15 };
    balance = await LeaveBalance.findOneAndUpdate(
      { companyId, employeeId, year },
      {
        $setOnInsert: {
          balances: {
            casual: { total: policy.casual || 0, used: 0 },
            sick: { total: policy.sick || 0, used: 0 },
            earned: { total: policy.earned || 0, used: 0 },
          },
        },
      },
      { upsert: true, new: true }
    );
  }
  return balance;
};

const calcDays = (fromDate, toDate, halfDay) => {
  const from = dayjs(fromDate);
  const to = dayjs(toDate);
  if (to.isBefore(from)) throw new ApiError(400, 'toDate cannot be before fromDate');
  const days = to.diff(from, 'day') + 1;
  if (halfDay && days === 1) return 0.5;
  return days;
};

// --- Multi-level approval chain (L1 manager → L2 hr_admin → L3 company_admin) ---
const LEVEL_ROLES = [ROLES.MANAGER, ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN];
const APPROVERS_BY_LEVEL = {
  1: [ROLES.MANAGER, ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN],
  2: [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN],
  3: [ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN],
};

// Builds the approval chain from company settings — default 1 level (= legacy behaviour).
const buildApprovalChain = async (companyId, days) => {
  const company = await Company.findById(companyId).select('settings.leave').lean();
  const cfg = (company && company.settings && company.settings.leave) || {};
  const approvalLevels = [1, 2, 3].includes(Number(cfg.approvalLevels)) ? Number(cfg.approvalLevels) : 1;
  const level3MinDays = Number(cfg.level3MinDays) || 5;
  let requiredLevels = approvalLevels;
  if (approvalLevels >= 2 && days >= level3MinDays) requiredLevels = 3;
  return LEVEL_ROLES.slice(0, requiredLevels).map((role, i) => ({ level: i + 1, role, status: 'pending' }));
};

// Legacy/seeded leaves carry no chain — treat them as a single (final) manager level.
const ensureChain = (leave) => {
  if (!leave.approvalChain || !leave.approvalChain.length) {
    leave.approvalChain = [{ level: 1, role: ROLES.MANAGER, status: 'pending' }];
    leave.currentLevel = 1;
  }
};

// POST /leaves — apply
const applyLeave = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const { leaveType, fromDate, toDate, reason, halfDay } = req.body;
  if (!LEAVE_TYPES.includes(leaveType)) throw new ApiError(400, `leaveType must be one of: ${LEAVE_TYPES.join(', ')}`);
  if (!fromDate || !toDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new ApiError(400, 'fromDate and toDate (YYYY-MM-DD) are required');
  }
  if (!reason) throw new ApiError(400, 'reason is required');
  const days = calcDays(fromDate, toDate, halfDay);

  // overlap check
  const overlap = await Leave.exists({
    companyId,
    employeeId: req.user.employeeId,
    status: { $in: ['pending', 'approved'] },
    fromDate: { $lte: toDate },
    toDate: { $gte: fromDate },
  });
  if (overlap) throw new ApiError(409, 'You already have a leave request overlapping these dates');

  // balance validation (paid types)
  if (leaveType !== 'unpaid') {
    const balance = await ensureBalance(companyId, req.user.employeeId, dayjs(fromDate).year());
    const bucket = balance.balances[leaveType];
    const available = (bucket.total || 0) - (bucket.used || 0);
    if (days > available) {
      throw new ApiError(400, `Insufficient ${leaveType} leave balance. Available: ${available}, requested: ${days}`);
    }
  }

  const approvalChain = await buildApprovalChain(companyId, days);
  const leave = await Leave.create({
    companyId,
    employeeId: req.user.employeeId,
    leaveType,
    fromDate,
    toDate,
    days,
    halfDay: Boolean(halfDay),
    reason,
    approvalChain,
    currentLevel: 1,
  });

  // notify manager
  const employee = await Employee.findById(req.user.employeeId).select('job.managerId').lean();
  if (employee && employee.job && employee.job.managerId) {
    const manager = await Employee.findById(employee.job.managerId).select('userId').lean();
    if (manager && manager.userId) {
      await notify({
        companyId,
        userId: manager.userId,
        title: 'Leave request',
        message: `${req.user.name} applied for ${days} day(s) ${leaveType} leave (${fromDate} → ${toDate}).`,
        type: 'leave',
        meta: { leaveId: leave._id },
      });
    }
  }
  return created(res, leave, 'Leave applied');
});

// GET /leaves
const listLeaves = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  } else if (req.user.role === ROLES.MANAGER && req.user.employeeId && req.query.scope !== 'all') {
    const team = await Employee.find({ companyId, 'job.managerId': req.user.employeeId, isDeleted: false }).select('_id').lean();
    filter.employeeId = { $in: [...team.map((t) => t._id), req.user.employeeId] };
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.leaveType) filter.leaveType = req.query.leaveType;
  if (req.query.from) filter.toDate = { $gte: req.query.from };
  if (req.query.to) filter.fromDate = { ...(filter.fromDate || {}), $lte: req.query.to };
  const { items, pagination } = await paginate(req.query, Leave, filter, {
    searchFields: ['leaveType', 'reason', 'status'],
    sortable: ['createdAt', 'updatedAt', 'fromDate', 'toDate', 'days', 'leaveType', 'status'],
    populate: POPULATE,
  });
  return ok(res, items, 'Leaves', pagination);
});

// GET /leaves/balance?employeeId&year
const getBalance = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  let employeeId = req.query.employeeId;
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role) || !employeeId) {
    employeeId = req.user.employeeId;
  }
  if (!employeeId) throw new ApiError(400, 'employeeId is required');
  const year = Number(req.query.year) || dayjs().year();
  const balance = await ensureBalance(companyId, employeeId, year);
  const data = balance.toObject();
  for (const type of ['casual', 'sick', 'earned']) {
    data.balances[type].available = (data.balances[type].total || 0) - (data.balances[type].used || 0);
  }
  return ok(res, data, 'Leave balance');
});

// GET /leaves/balances?year — company-wide balances, one row per active employee
// (missing LeaveBalance docs are lazily created so every active employee appears).
const listBalances = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const year = Number(req.query.year) || dayjs().year();

  const employees = await Employee.find({ companyId, isDeleted: false, status: 'active' })
    .select('employeeCode personal.firstName personal.lastName job.departmentId')
    .populate('job.departmentId', 'name')
    .sort({ employeeCode: 1 })
    .lean();

  const unpaidAgg = await Leave.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(String(companyId)),
        leaveType: 'unpaid',
        status: 'approved',
        fromDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
      },
    },
    { $group: { _id: '$employeeId', days: { $sum: '$days' } } },
  ]);
  const unpaidMap = new Map(unpaidAgg.map((u) => [String(u._id), u.days]));

  const items = [];
  for (const emp of employees) {
    // eslint-disable-next-line no-await-in-loop
    const balance = await ensureBalance(companyId, emp._id, year);
    const buckets = {};
    let totalRemaining = 0;
    for (const type of ['casual', 'sick', 'earned']) {
      const b = (balance.balances && balance.balances[type]) || {};
      const total = b.total || 0;
      const used = b.used || 0;
      buckets[type] = { total, used, available: total - used };
      totalRemaining += total - used;
    }
    items.push({
      employee: {
        _id: emp._id,
        employeeCode: emp.employeeCode,
        personal: {
          firstName: emp.personal ? emp.personal.firstName : '',
          lastName: emp.personal ? emp.personal.lastName : '',
        },
        job: {
          departmentId: emp.job && emp.job.departmentId ? { name: emp.job.departmentId.name } : null,
        },
      },
      year,
      ...buckets,
      unpaidTaken: unpaidMap.get(String(emp._id)) || 0,
      totalRemaining,
    });
  }

  // v1.5 list contract over the computed rows — slicing is OPT-IN (only when
  // ?page/?limit are sent), so legacy callers keep receiving every row.
  const empName = (r) => `${r.employee.personal.firstName || ''} ${r.employee.personal.lastName || ''}`.trim().toLowerCase();
  const { items: rows, pagination } = paginateArray(req.query, items, {
    searchValues: (r) => [r.employee.employeeCode, r.employee.personal.firstName, r.employee.personal.lastName, empName(r)],
    sortable: {
      employeeCode: (r) => r.employee.employeeCode || '',
      name: empName,
      unpaidTaken: (r) => r.unpaidTaken,
      totalRemaining: (r) => r.totalRemaining,
    },
  });
  return ok(res, { items: rows }, 'Leave balances', pagination);
});

// PATCH /leaves/:id/approve  { note? } — approves the CURRENT chain level.
// Non-final levels advance the chain (status stays 'pending'); the final level
// approves the leave and debits the balance. Default 1 level === legacy behaviour.
const approveLeave = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const leave = await Leave.findOne({ _id: req.params.id, companyId }).populate(POPULATE);
  if (!leave) throw new ApiError(404, 'Leave not found');
  if (leave.status !== 'pending') throw new ApiError(400, `Leave is '${leave.status}', expected 'pending'`);

  ensureChain(leave);
  const level = leave.currentLevel || 1;
  const allowed = APPROVERS_BY_LEVEL[level] || APPROVERS_BY_LEVEL[3];
  if (!allowed.includes(req.user.role)) {
    throw new ApiError(403, `Level ${level} approval requires one of: ${allowed.join(', ')}`);
  }
  const step = leave.approvalChain.find((s) => s.level === level);
  step.status = 'approved';
  step.by = req.user.userId;
  step.at = new Date();
  step.note = req.body.note || null;

  // intermediate level → advance the chain, leave stays pending
  if (level < leave.approvalChain.length) {
    leave.currentLevel = level + 1;
    leave.markModified('approvalChain');
    await leave.save();
    if (leave.employeeId.userId) {
      await notify({
        companyId,
        userId: leave.employeeId.userId,
        title: 'Leave approval update',
        message: `Your ${leave.leaveType} leave (${leave.fromDate} → ${leave.toDate}) was approved at level ${level} — pending level ${level + 1} approval.`,
        type: 'leave',
      });
    }
    return ok(res, leave, `Leave approved at level ${level} — pending level ${level + 1}`);
  }

  // final level → debit balance (existing logic) and approve
  if (leave.leaveType !== 'unpaid') {
    const employeeId = leave.employeeId._id || leave.employeeId;
    const balance = await ensureBalance(companyId, employeeId, dayjs(leave.fromDate).year());
    const bucket = balance.balances[leave.leaveType];
    if ((bucket.total || 0) - (bucket.used || 0) < leave.days) {
      throw new ApiError(400, `Insufficient ${leave.leaveType} balance to approve`);
    }
    bucket.used = (bucket.used || 0) + leave.days;
    balance.markModified('balances');
    await balance.save();
  }

  leave.status = 'approved';
  leave.approvedBy = req.user.userId;
  leave.approvedAt = new Date();
  leave.markModified('approvalChain');
  await leave.save();

  if (leave.employeeId.userId) {
    await notify({
      companyId,
      userId: leave.employeeId.userId,
      title: 'Leave approved',
      message: `Your ${leave.leaveType} leave (${leave.fromDate} → ${leave.toDate}) has been approved.`,
      type: 'leave',
    });
  }
  return ok(res, leave, 'Leave approved');
});

// PATCH /leaves/:id/reject  { reason? } — reject at the current chain level
const rejectLeave = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const leave = await Leave.findOne({ _id: req.params.id, companyId }).populate(POPULATE);
  if (!leave) throw new ApiError(404, 'Leave not found');
  if (leave.status !== 'pending') throw new ApiError(400, `Leave is '${leave.status}', expected 'pending'`);

  ensureChain(leave);
  const level = leave.currentLevel || 1;
  const allowed = APPROVERS_BY_LEVEL[level] || APPROVERS_BY_LEVEL[3];
  if (!allowed.includes(req.user.role)) {
    throw new ApiError(403, `Level ${level} rejection requires one of: ${allowed.join(', ')}`);
  }
  const step = leave.approvalChain.find((s) => s.level === level);
  step.status = 'rejected';
  step.by = req.user.userId;
  step.at = new Date();
  step.note = req.body.reason || null;

  leave.status = 'rejected';
  leave.approvedBy = req.user.userId;
  leave.approvedAt = new Date();
  leave.rejectionReason = req.body.reason || null;
  leave.markModified('approvalChain');
  await leave.save();
  if (leave.employeeId.userId) {
    await notify({
      companyId,
      userId: leave.employeeId.userId,
      title: 'Leave rejected',
      message: `Your ${leave.leaveType} leave (${leave.fromDate} → ${leave.toDate}) was rejected${req.body.reason ? `: ${req.body.reason}` : '.'}`,
      type: 'leave',
    });
  }
  return ok(res, leave, 'Leave rejected');
});

// PATCH /leaves/:id/cancel — own leave
const cancelLeave = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const leave = await Leave.findOne({ _id: req.params.id, companyId, employeeId: req.user.employeeId });
  if (!leave) throw new ApiError(404, 'Leave not found');
  if (!['pending', 'approved'].includes(leave.status)) {
    throw new ApiError(400, `Leave is '${leave.status}' and cannot be cancelled`);
  }
  // restore balance when an approved paid leave is cancelled
  if (leave.status === 'approved' && leave.leaveType !== 'unpaid') {
    const balance = await ensureBalance(companyId, leave.employeeId, dayjs(leave.fromDate).year());
    const bucket = balance.balances[leave.leaveType];
    bucket.used = Math.max((bucket.used || 0) - leave.days, 0);
    balance.markModified('balances');
    await balance.save();
  }
  leave.status = 'cancelled';
  leave.cancelledAt = new Date();
  await leave.save();
  return ok(res, leave, 'Leave cancelled');
});

module.exports = { applyLeave, listLeaves, getBalance, listBalances, approveLeave, rejectLeave, cancelLeave };
