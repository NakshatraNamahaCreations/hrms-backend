const dayjs = require('dayjs');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const FieldVisit = require('../models/FieldVisit');
const Leave = require('../models/Leave');
const Payroll = require('../models/Payroll');
const Resignation = require('../models/Resignation');
const Company = require('../models/Company');
const CompanySubscription = require('../models/CompanySubscription');
const Payment = require('../models/Payment');
const FieldExpense = require('../models/FieldExpense');
const Asset = require('../models/Asset');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { getEffectiveFeatures } = require('../middleware/requireFeature');
const fieldAttendanceService = require('../services/fieldAttendance.service');
const { ROLES, FEATURE_KEYS } = require('../constants');

const empName = (e) => (e && e.personal ? `${e.personal.firstName} ${e.personal.lastName || ''}`.trim() : '');

// Department and employee-status filters apply to every company report, but the
// reports are rooted on different collections: employee-rooted ones can match in
// place, the rest need the matching employee ids resolved first.
const employeeMatch = (req) => {
  const match = {};
  if (req.query.departmentId) match['job.departmentId'] = req.query.departmentId;
  const status = req.query.employeeStatus;
  if (status && status !== 'all') match.status = status;
  return match;
};

// Returns null when no employee-level filter is active so callers skip the extra
// query entirely — scoping to an id list would otherwise silently drop rows whose
// employee reference no longer resolves.
const scopedEmployeeIds = async (companyId, req) => {
  const match = employeeMatch(req);
  if (!Object.keys(match).length) return null;
  const docs = await Employee.find({ companyId, isDeleted: false, ...match }).select('_id').lean();
  return docs.map((d) => d._id);
};

// Narrows a filter rooted on another collection to the scoped employees.
const withEmployeeScope = (filter, ids, field = 'employeeId') => {
  if (ids === null) return filter;
  return { ...filter, [field]: { $in: ids } };
};

const dateRange = (req) => {
  const from = req.query.from || dayjs().startOf('month').format('YYYY-MM-DD');
  const to = req.query.to || dayjs().format('YYYY-MM-DD');
  return { from, to };
};

// ---- report builders: each returns { columns: [], rows: [{}] } -------------

const employeesReport = async (companyId, req) => {
  const filter = { companyId, isDeleted: false };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.employeeType) filter['job.employeeType'] = req.query.employeeType;
  Object.assign(filter, employeeMatch(req));
  const employees = await Employee.find(filter)
    .populate('job.branchId job.departmentId job.designationId', 'name')
    .lean();
  return {
    columns: ['employeeCode', 'name', 'email', 'phone', 'branch', 'department', 'designation', 'employeeType', 'joiningDate', 'status'],
    rows: employees.map((e) => ({
      employeeCode: e.employeeCode,
      name: empName(e),
      email: e.personal.email,
      phone: e.personal.phone || '',
      branch: e.job.branchId ? e.job.branchId.name : '',
      department: e.job.departmentId ? e.job.departmentId.name : '',
      designation: e.job.designationId ? e.job.designationId.name : '',
      employeeType: e.job.employeeType,
      joiningDate: e.job.joiningDate ? dayjs(e.job.joiningDate).format('YYYY-MM-DD') : '',
      status: e.status,
    })),
  };
};

const attendanceReport = async (companyId, req, extraFilter = {}) => {
  const { from, to } = dateRange(req);
  let filter = { companyId, date: { $gte: from, $lte: to }, ...extraFilter };
  if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  else filter = withEmployeeScope(filter, await scopedEmployeeIds(companyId, req));
  const records = await Attendance.find(filter)
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName')
    .sort({ date: 1 })
    .lean();
  return {
    columns: ['date', 'employeeCode', 'name', 'status', 'checkIn', 'checkOut', 'lateMinutes', 'totalHours', 'source'],
    rows: records.map((r) => ({
      date: r.date,
      employeeCode: r.employeeId ? r.employeeId.employeeCode : '',
      name: empName(r.employeeId),
      status: r.status,
      checkIn: r.checkIn && r.checkIn.time ? dayjs(r.checkIn.time).format('HH:mm') : '',
      checkOut: r.checkOut && r.checkOut.time ? dayjs(r.checkOut.time).format('HH:mm') : '',
      lateMinutes: r.lateMinutes || 0,
      totalHours: r.totalHours || 0,
      source: r.attendanceSource,
    })),
  };
};

const fieldAttendanceReport = async (companyId, req) => {
  const { from, to } = dateRange(req);
  const filter = { companyId, isDeleted: false, 'job.employeeType': 'field_employee', ...employeeMatch(req) };
  const fieldEmployees = await Employee.find(filter).select('employeeCode personal').lean();
  const rows = [];
  for (const emp of fieldEmployees) {
    let cur = dayjs(from);
    const end = dayjs(to);
    while (cur.isBefore(end) || cur.isSame(end, 'day')) {
      const date = cur.format('YYYY-MM-DD');
      // eslint-disable-next-line no-await-in-loop
      const summary = await fieldAttendanceService.dailySummary(companyId, emp._id, date);
      if (summary.totalVisits > 0) {
        rows.push({
          date,
          employeeCode: emp.employeeCode,
          name: empName(emp),
          totalVisits: summary.totalVisits,
          completedVisits: summary.completedVisits,
          pendingVisits: summary.pendingVisits,
          totalWorkMinutes: summary.totalWorkMinutes,
          travelMinutes: summary.travelMinutes,
          totalDistanceKm: summary.totalDistanceKm,
        });
      }
      cur = cur.add(1, 'day');
    }
  }
  return {
    columns: ['date', 'employeeCode', 'name', 'totalVisits', 'completedVisits', 'pendingVisits', 'totalWorkMinutes', 'travelMinutes', 'totalDistanceKm'],
    rows,
  };
};

const clientVisitsReport = async (companyId, req) => {
  const { from, to } = dateRange(req);
  let filter = { companyId, date: { $gte: from, $lte: to } };
  if (req.query.clientId) filter.clientId = req.query.clientId;
  filter = withEmployeeScope(filter, await scopedEmployeeIds(companyId, req));
  const visits = await FieldVisit.find(filter)
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName')
    .populate('clientId', 'name')
    .populate('workAssignmentId', 'title status')
    .sort({ date: 1 })
    .lean();
  return {
    columns: ['date', 'employeeCode', 'employee', 'client', 'assignment', 'checkIn', 'checkOut', 'workMinutes', 'distanceMeters', 'proofStatus', 'approvalStatus'],
    rows: visits.map((v) => ({
      date: v.date,
      employeeCode: v.employeeId ? v.employeeId.employeeCode : '',
      employee: empName(v.employeeId),
      client: v.clientId ? v.clientId.name : '',
      assignment: v.workAssignmentId ? v.workAssignmentId.title : '',
      checkIn: v.checkInTime ? dayjs(v.checkInTime).format('HH:mm') : '',
      checkOut: v.checkOutTime ? dayjs(v.checkOutTime).format('HH:mm') : '',
      workMinutes: v.totalWorkMinutes || 0,
      distanceMeters: v.distanceMeters || 0,
      proofStatus: v.proofStatus || '',
      approvalStatus: v.approvalStatus,
    })),
  };
};

const leavesReport = async (companyId, req) => {
  const { from, to } = dateRange(req);
  let filter = { companyId, fromDate: { $lte: to }, toDate: { $gte: from } };
  if (req.query.status) filter.status = req.query.status;
  filter = withEmployeeScope(filter, await scopedEmployeeIds(companyId, req));
  const leaves = await Leave.find(filter)
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName')
    .lean();
  return {
    columns: ['employeeCode', 'name', 'leaveType', 'fromDate', 'toDate', 'days', 'status', 'reason'],
    rows: leaves.map((l) => ({
      employeeCode: l.employeeId ? l.employeeId.employeeCode : '',
      name: empName(l.employeeId),
      leaveType: l.leaveType,
      fromDate: l.fromDate,
      toDate: l.toDate,
      days: l.days,
      status: l.status,
      reason: l.reason,
    })),
  };
};

const payrollReport = async (companyId, req) => {
  const month = Number(req.query.month) || dayjs().month() + 1;
  const year = Number(req.query.year) || dayjs().year();
  const items = await Payroll.find(withEmployeeScope({ companyId, month, year }, await scopedEmployeeIds(companyId, req)))
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName')
    .lean();
  return {
    columns: ['employeeCode', 'name', 'month', 'year', 'payableDays', 'lopDays', 'gross', 'pf', 'esi', 'professionalTax', 'tds', 'totalDeductions', 'netSalary', 'status'],
    rows: items.map((p) => ({
      employeeCode: p.employeeId ? p.employeeId.employeeCode : '',
      name: empName(p.employeeId),
      month: p.month,
      year: p.year,
      payableDays: p.payableDays,
      lopDays: p.lopDays,
      gross: p.earnings.gross,
      pf: p.deductions.pf,
      esi: p.deductions.esi,
      professionalTax: p.deductions.professionalTax,
      tds: p.deductions.tds,
      totalDeductions: p.deductions.total,
      netSalary: p.netSalary,
      status: p.status,
    })),
  };
};

const newJoinersReport = async (companyId, req) => {
  const { from, to } = dateRange(req);
  const employees = await Employee.find({
    companyId,
    isDeleted: false,
    'job.joiningDate': { $gte: dayjs(from).toDate(), $lte: dayjs(to).endOf('day').toDate() },
    ...employeeMatch(req),
  })
    .populate('job.departmentId job.designationId', 'name')
    .lean();
  return {
    columns: ['employeeCode', 'name', 'email', 'department', 'designation', 'employeeType', 'joiningDate', 'onboardingStatus'],
    rows: employees.map((e) => ({
      employeeCode: e.employeeCode,
      name: empName(e),
      email: e.personal.email,
      department: e.job.departmentId ? e.job.departmentId.name : '',
      designation: e.job.designationId ? e.job.designationId.name : '',
      employeeType: e.job.employeeType,
      joiningDate: dayjs(e.job.joiningDate).format('YYYY-MM-DD'),
      onboardingStatus: e.onboardingStatus,
    })),
  };
};

const exitsReport = async (companyId, req) => {
  let filter = { companyId };
  if (req.query.status) filter.status = req.query.status;
  filter = withEmployeeScope(filter, await scopedEmployeeIds(companyId, req));
  const resignations = await Resignation.find(filter)
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName')
    .lean();
  return {
    columns: ['employeeCode', 'name', 'resignationDate', 'lastWorkingDate', 'noticePeriodDays', 'status', 'fnfAmount', 'reason'],
    rows: resignations.map((r) => ({
      employeeCode: r.employeeId ? r.employeeId.employeeCode : '',
      name: empName(r.employeeId),
      resignationDate: dayjs(r.resignationDate).format('YYYY-MM-DD'),
      lastWorkingDate: r.lastWorkingDate ? dayjs(r.lastWorkingDate).format('YYYY-MM-DD') : '',
      noticePeriodDays: r.noticePeriodDays,
      status: r.status,
      fnfAmount: r.fnfAmount || 0,
      reason: r.reason,
    })),
  };
};

const expensesReport = async (companyId, req) => {
  const { from, to } = dateRange(req);
  let filter = { companyId, date: { $gte: from, $lte: to } };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  else filter = withEmployeeScope(filter, await scopedEmployeeIds(companyId, req));
  const expenses = await FieldExpense.find(filter)
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName')
    .sort({ date: 1 })
    .lean();
  return {
    columns: ['date', 'employeeCode', 'employeeName', 'category', 'amount', 'status', 'description'],
    rows: expenses.map((x) => ({
      date: x.date,
      employeeCode: x.employeeId ? x.employeeId.employeeCode : '',
      employeeName: empName(x.employeeId),
      category: x.category,
      amount: x.amount,
      status: x.status,
      description: x.description || '',
    })),
  };
};

const assetsReport = async (companyId, req) => {
  const filter = { companyId, isDeleted: false };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  const assetFilter = withEmployeeScope(filter, await scopedEmployeeIds(companyId, req), 'assignedTo');
  const assets = await Asset.find(assetFilter)
    .populate('assignedTo', 'employeeCode personal.firstName personal.lastName')
    .lean();
  return {
    columns: ['name', 'assetCode', 'serialNumber', 'category', 'status', 'assignedTo', 'value'],
    rows: assets.map((a) => ({
      name: a.name,
      assetCode: a.code || '',
      serialNumber: a.serialNumber || '',
      category: a.category,
      status: a.status,
      assignedTo: empName(a.assignedTo),
      value: a.value || 0,
    })),
  };
};

// platform-level (super_admin only)
const subscriptionsReport = async () => {
  const subs = await CompanySubscription.find({})
    .populate('companyId', 'name code')
    .populate('planId', 'name')
    .sort({ createdAt: -1 })
    .lean();
  return {
    columns: ['company', 'plan', 'billingCycle', 'status', 'startDate', 'endDate', 'amount', 'employeeLimit', 'fieldEmployeeLimit'],
    rows: subs.map((s) => ({
      company: s.companyId ? s.companyId.name : '',
      plan: s.planId ? s.planId.name : '',
      billingCycle: s.billingCycle,
      status: s.status,
      startDate: dayjs(s.startDate).format('YYYY-MM-DD'),
      endDate: dayjs(s.endDate).format('YYYY-MM-DD'),
      amount: s.amount || 0,
      employeeLimit: s.employeeLimit,
      fieldEmployeeLimit: s.fieldEmployeeLimit,
    })),
  };
};

const revenueReport = async (companyIdIgnored, req) => {
  const from = req.query.from ? dayjs(req.query.from).toDate() : dayjs().startOf('year').toDate();
  const to = req.query.to ? dayjs(req.query.to).endOf('day').toDate() : new Date();
  const payments = await Payment.find({ status: 'paid', paidAt: { $gte: from, $lte: to } })
    .populate('companyId', 'name')
    .populate('planId', 'name')
    .sort({ paidAt: 1 })
    .lean();
  return {
    columns: ['date', 'invoiceNumber', 'company', 'plan', 'billingCycle', 'amount', 'mode'],
    rows: payments.map((p) => ({
      date: dayjs(p.paidAt).format('YYYY-MM-DD'),
      invoiceNumber: p.invoiceNumber || '',
      company: p.companyId ? p.companyId.name : '',
      plan: p.planId ? p.planId.name : '',
      billingCycle: p.billingCycle,
      amount: p.amount,
      mode: p.mode,
    })),
  };
};

const companiesReport = async () => {
  const companies = await Company.find({ isDeleted: false }).sort({ createdAt: 1 }).lean();
  const subs = await CompanySubscription.find({}).sort({ createdAt: 1 }).populate('planId', 'name').lean();
  const subMap = new Map();
  for (const s of subs) subMap.set(String(s.companyId), s); // later entries overwrite => latest
  const counts = await Employee.aggregate([
    { $match: { isDeleted: false } },
    { $group: { _id: '$companyId', total: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.total]));
  return {
    columns: ['name', 'plan', 'status', 'employeeCount', 'createdAt'],
    rows: companies.map((c) => {
      const sub = subMap.get(String(c._id));
      return {
        name: c.name,
        plan: sub && sub.planId ? sub.planId.name : '',
        status: c.status,
        employeeCount: countMap.get(String(c._id)) || 0,
        createdAt: dayjs(c.createdAt).format('YYYY-MM-DD'),
      };
    }),
  };
};

const paymentsReport = async (companyIdIgnored, req) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const payments = await Payment.find(filter)
    .populate('companyId', 'name')
    .sort({ createdAt: -1 })
    .lean();
  return {
    columns: ['companyName', 'invoiceNumber', 'amount', 'status', 'method', 'date'],
    rows: payments.map((p) => ({
      companyName: p.companyId ? p.companyId.name : '',
      invoiceNumber: p.invoiceNumber || '',
      amount: p.amount,
      status: p.status,
      method: p.method || p.mode || '',
      date: dayjs(p.paidAt || p.createdAt).format('YYYY-MM-DD'),
    })),
  };
};

// companies whose effective features (plan + overrides) enable each feature key
const featureUsageReport = async () => {
  const companies = await Company.find({ isDeleted: false }).select('_id').lean();
  const counts = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0]));
  for (const c of companies) {
    // eslint-disable-next-line no-await-in-loop
    const features = await getEffectiveFeatures(c._id);
    for (const key of features) {
      if (counts[key] !== undefined) counts[key] += 1;
    }
  }
  return {
    columns: ['featureKey', 'companiesEnabled'],
    rows: FEATURE_KEYS.map((k) => ({ featureKey: k, companiesEnabled: counts[k] })),
  };
};

const BUILDERS = {
  employees: employeesReport,
  attendance: (companyId, req) => attendanceReport(companyId, req),
  'field-attendance': fieldAttendanceReport,
  'client-visits': clientVisitsReport,
  leaves: leavesReport,
  payroll: payrollReport,
  'late-coming': (companyId, req) => attendanceReport(companyId, req, { lateMinutes: { $gt: 0 } }),
  absent: (companyId, req) => attendanceReport(companyId, req, { status: 'absent' }),
  'new-joiners': newJoinersReport,
  exits: exitsReport,
  expenses: expensesReport,
  assets: assetsReport,
  subscriptions: subscriptionsReport,
  revenue: revenueReport,
  companies: companiesReport,
  payments: paymentsReport,
  'feature-usage': featureUsageReport,
};

const PLATFORM_ONLY = ['subscriptions', 'revenue', 'companies', 'payments', 'feature-usage'];

const csvEscape = (value) => {
  const str = value == null ? '' : String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
};

// GET /reports/:type?format=csv
const getReport = asyncHandler(async (req, res) => {
  const { type } = req.params;
  const builder = BUILDERS[type];
  if (!builder) {
    throw new ApiError(404, `Unknown report type '${type}'. Available: ${Object.keys(BUILDERS).join(', ')}`);
  }
  if (PLATFORM_ONLY.includes(type) && req.user.role !== ROLES.SUPER_ADMIN) {
    throw new ApiError(403, 'This report is only available to the platform owner');
  }

  let companyId = null;
  if (!PLATFORM_ONLY.includes(type)) companyId = getCompanyId(req);

  const { columns, rows } = await builder(companyId, req);

  if ((req.query.format || '').toLowerCase() === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report-${dayjs().format('YYYYMMDD')}.csv"`);
    res.write(`${columns.map(csvEscape).join(',')}\r\n`);
    for (const row of rows) {
      res.write(`${columns.map((c) => csvEscape(row[c])).join(',')}\r\n`);
    }
    return res.end();
  }
  return ok(res, { type, columns, rows, count: rows.length }, `${type} report`);
});

module.exports = { getReport };
