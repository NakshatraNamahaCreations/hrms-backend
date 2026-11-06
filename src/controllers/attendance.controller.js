const dayjs = require('dayjs');
const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const Company = require('../models/Company');
const Shift = require('../models/Shift');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isManagerial } = require('../utils/scope');
const { logAudit } = require('../middleware/audit');
const payrollService = require('../services/payroll.service');
const { ROLES, ATTENDANCE_STATUS } = require('../constants');

const today = () => dayjs().format('YYYY-MM-DD');

const minutesFromHHmm = (hhmm) => {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Resolves the shift rules for an employee (employee shift > company office timings).
const resolveShiftRules = async (companyId, employee) => {
  const company = await Company.findById(companyId).select('settings').lean();
  const att = (company && company.settings && company.settings.attendance) || {};
  let shift = null;
  if (employee.job && employee.job.shiftId) {
    shift = await Shift.findOne({ _id: employee.job.shiftId, companyId, isDeleted: false }).lean();
  }
  return {
    shiftId: shift ? shift._id : null,
    startTime: (shift && shift.startTime) || (company && company.settings.officeTimings && company.settings.officeTimings.startTime) || '09:30',
    endTime: (shift && shift.endTime) || (company && company.settings.officeTimings && company.settings.officeTimings.endTime) || '18:30',
    graceMinutes: (shift && shift.graceMinutes) != null ? shift.graceMinutes : att.graceMinutes != null ? att.graceMinutes : 15,
    halfDayHours: (shift && shift.halfDayHours) || att.halfDayHours || 4,
    fullDayHours: (shift && shift.fullDayHours) || att.fullDayHours || 8,
  };
};

const requireOwnEmployee = (req) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  return req.user.employeeId;
};

const assertMonthNotLocked = async (companyId, date) => {
  const d = dayjs(date);
  if (await payrollService.isMonthLocked(companyId, d.month() + 1, d.year())) {
    throw new ApiError(423, `Attendance for ${d.format('MMMM YYYY')} is locked (payroll finalized)`);
  }
};

// POST /attendance/check-in  { latitude?, longitude?, address?, source?, device? }
const checkIn = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const employeeId = requireOwnEmployee(req);
  const date = today();
  await assertMonthNotLocked(companyId, date);

  const existing = await Attendance.findOne({ companyId, employeeId, date });
  if (existing && existing.checkIn && existing.checkIn.time) {
    throw new ApiError(409, 'You have already checked in today');
  }

  const employee = await Employee.findById(employeeId).lean();
  const rules = await resolveShiftRules(companyId, employee);
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = minutesFromHHmm(rules.startTime);
  const lateMinutes = startMinutes != null ? Math.max(nowMinutes - (startMinutes + rules.graceMinutes), 0) : 0;

  const source = req.body.source === 'employee_app' ? 'employee_app' : 'web';
  const punch = {
    time: now,
    location: req.body.latitude != null
      ? { latitude: req.body.latitude, longitude: req.body.longitude, address: req.body.address }
      : undefined,
    device: req.body.device || req.headers['user-agent'] || null,
    source,
  };

  const attendance = await Attendance.findOneAndUpdate(
    { companyId, employeeId, date },
    {
      $set: {
        checkIn: punch,
        shiftId: rules.shiftId,
        status: lateMinutes > 0 ? 'late' : 'present',
        attendanceSource: source,
        lateMinutes,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return created(res, attendance, lateMinutes > 0 ? `Checked in (late by ${lateMinutes} min)` : 'Checked in');
});

// POST /attendance/check-out
const checkOut = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const employeeId = requireOwnEmployee(req);
  const date = today();
  await assertMonthNotLocked(companyId, date);

  const attendance = await Attendance.findOne({ companyId, employeeId, date });
  if (!attendance || !attendance.checkIn || !attendance.checkIn.time) {
    throw new ApiError(400, 'You have not checked in today');
  }
  if (attendance.checkOut && attendance.checkOut.time) {
    throw new ApiError(409, 'You have already checked out today');
  }

  const employee = await Employee.findById(employeeId).lean();
  const rules = await resolveShiftRules(companyId, employee);
  const now = new Date();
  const source = req.body.source === 'employee_app' ? 'employee_app' : 'web';

  attendance.checkOut = {
    time: now,
    location: req.body.latitude != null
      ? { latitude: req.body.latitude, longitude: req.body.longitude, address: req.body.address }
      : undefined,
    device: req.body.device || req.headers['user-agent'] || null,
    source,
  };

  const workMinutes = Math.max(Math.round((now - new Date(attendance.checkIn.time)) / 60000), 0);
  attendance.workMinutes = workMinutes;
  attendance.totalHours = Math.round((workMinutes / 60) * 100) / 100;

  const endMinutes = minutesFromHHmm(rules.endTime);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  attendance.earlyExitMinutes = endMinutes != null ? Math.max(endMinutes - nowMinutes, 0) : 0;

  // auto status: half_day > late > early_exit > present
  if (attendance.totalHours < rules.halfDayHours) attendance.status = 'half_day';
  else if (attendance.lateMinutes > 0) attendance.status = 'late';
  else if (attendance.earlyExitMinutes > 0) attendance.status = 'early_exit';
  else attendance.status = 'present';

  await attendance.save();
  return ok(res, attendance, 'Checked out');
});

// GET /attendance/today (self)
const getToday = asyncHandler(async (req, res) => {
  const employeeId = requireOwnEmployee(req);
  const attendance = await Attendance.findOne({ companyId: req.user.companyId, employeeId, date: today() }).lean();
  return ok(res, attendance, 'Today attendance');
});

// POST /attendance/manual  { date, entries: [{ employeeId, status, checkIn?, checkOut?, remarks? }] }
const manualMark = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { date, entries } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'date (YYYY-MM-DD) is required');
  if (!Array.isArray(entries) || !entries.length) throw new ApiError(400, 'entries[] is required');
  await assertMonthNotLocked(companyId, date);

  const results = [];
  for (const entry of entries) {
    if (!entry.employeeId || !ATTENDANCE_STATUS.includes(entry.status)) {
      results.push({ employeeId: entry.employeeId, ok: false, error: 'employeeId and a valid status are required' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const employee = await Employee.findOne({ _id: entry.employeeId, companyId, isDeleted: false }).select('_id').lean();
    if (!employee) {
      results.push({ employeeId: entry.employeeId, ok: false, error: 'Employee not found' });
      continue;
    }
    const update = {
      status: entry.status,
      attendanceSource: 'manual',
      remarks: entry.remarks || null,
      markedBy: req.user.userId,
    };
    if (entry.checkIn) update.checkIn = { time: new Date(entry.checkIn), source: 'manual' };
    if (entry.checkOut) update.checkOut = { time: new Date(entry.checkOut), source: 'manual' };
    if (entry.checkIn && entry.checkOut) {
      const workMinutes = Math.max(Math.round((new Date(entry.checkOut) - new Date(entry.checkIn)) / 60000), 0);
      update.workMinutes = workMinutes;
      update.totalHours = Math.round((workMinutes / 60) * 100) / 100;
    }
    // eslint-disable-next-line no-await-in-loop
    const doc = await Attendance.findOneAndUpdate(
      { companyId, employeeId: entry.employeeId, date },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    results.push({ employeeId: entry.employeeId, ok: true, attendanceId: doc._id, status: doc.status });
  }

  logAudit(req, {
    action: 'attendance.manual_mark',
    entityType: 'Attendance',
    meta: { date, count: entries.length, results: results.map((r) => ({ employeeId: r.employeeId, ok: r.ok })) },
  });
  return ok(res, { date, results }, 'Manual attendance saved');
});

// GET /attendance  ?employeeId&from&to&date&month(YYYY-MM)&status&page&limit
const listAttendance = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };

  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = requireOwnEmployee(req);
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  } else if (req.user.role === ROLES.MANAGER && req.user.employeeId) {
    // manager: own team
    const team = await Employee.find({ companyId, 'job.managerId': req.user.employeeId, isDeleted: false }).select('_id').lean();
    filter.employeeId = { $in: [...team.map((t) => t._id), req.user.employeeId] };
  }

  if (req.query.date) filter.date = req.query.date;
  else if (req.query.month) {
    if (!/^\d{4}-\d{2}$/.test(req.query.month)) throw new ApiError(400, 'month must be YYYY-MM');
    const start = dayjs(`${req.query.month}-01`);
    filter.date = { $gte: start.format('YYYY-MM-DD'), $lte: start.endOf('month').format('YYYY-MM-DD') };
  } else if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = req.query.from;
    if (req.query.to) filter.date.$lte = req.query.to;
  }
  if (req.query.status) filter.status = req.query.status;
  // the admin panel sends ?attendanceSource= (matching the model field); ?source= is the legacy alias
  const source = req.query.attendanceSource || req.query.source;
  if (source) filter.attendanceSource = source;

  const { items, pagination } = await paginate(req.query, Attendance, filter, {
    searchFields: ['date', 'status', 'attendanceSource'],
    sortable: ['date', 'status', 'attendanceSource', 'checkIn.time', 'createdAt', 'updatedAt'],
    populate: [{ path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName job.departmentId' }],
    sort: { date: -1 },
  });
  return ok(res, items, 'Attendance records', pagination);
});

// GET /attendance/summary
// - ?employeeId&month&year → per-employee monthly summary (employees default to self)
// - no employeeId + managerial role → company-wide DAILY summary for ?date
//   (defaults to today): { date, statusCounts, checkedOut, total } — this feeds
//   the admin dashboard stat cards (mirrors fieldVisit summary's companyWide mode).
const monthlySummary = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  let employeeId = req.query.employeeId;
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    employeeId = requireOwnEmployee(req);
  }
  if (!employeeId) {
    if (!isManagerial(req.user.role)) throw new ApiError(400, 'employeeId is required');
    const date = String(req.query.date || today());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'date must be YYYY-MM-DD');
    const [byStatus, checkedOut] = await Promise.all([
      Attendance.aggregate([
        { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)), date } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Attendance.countDocuments({ companyId, date, 'checkOut.time': { $ne: null } }),
    ]);
    const statusCounts = {};
    for (const s of ATTENDANCE_STATUS) statusCounts[s] = 0;
    let total = 0;
    for (const row of byStatus) {
      statusCounts[row._id] = (statusCounts[row._id] || 0) + row.count;
      total += row.count;
    }
    return ok(res, { date, statusCounts, checkedOut, total }, 'Daily attendance summary');
  }
  const month = Number(req.query.month) || dayjs().month() + 1;
  const year = Number(req.query.year) || dayjs().year();
  const monthStr = String(month).padStart(2, '0');
  const daysInMonth = dayjs(`${year}-${monthStr}-01`).daysInMonth();

  const records = await Attendance.find({
    companyId,
    employeeId,
    date: { $gte: `${year}-${monthStr}-01`, $lte: `${year}-${monthStr}-${String(daysInMonth).padStart(2, '0')}` },
  })
    .sort({ date: 1 })
    .lean();

  const counts = {};
  for (const s of ATTENDANCE_STATUS) counts[s] = 0;
  let totalWorkMinutes = 0;
  let totalLateMinutes = 0;
  for (const r of records) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    totalWorkMinutes += r.workMinutes || 0;
    totalLateMinutes += r.lateMinutes || 0;
  }

  return ok(res, {
    employeeId,
    month,
    year,
    daysInMonth,
    markedDays: records.length,
    counts,
    totalWorkMinutes,
    totalWorkHours: Math.round((totalWorkMinutes / 60) * 100) / 100,
    totalLateMinutes,
    records,
    locked: await payrollService.isMonthLocked(companyId, month, year),
  }, 'Monthly attendance summary');
});

module.exports = { checkIn, checkOut, getToday, manualMark, listAttendance, monthlySummary, assertMonthNotLocked };
