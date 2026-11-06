const dayjs = require('dayjs');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Department = require('../models/Department');
const Attendance = require('../models/Attendance');
const AttendanceCorrection = require('../models/AttendanceCorrection');
const Leave = require('../models/Leave');
const FieldVisit = require('../models/FieldVisit');
const FieldWorkAssignment = require('../models/FieldWorkAssignment');
const Payroll = require('../models/Payroll');
const EmployeeDocument = require('../models/EmployeeDocument');
const Ticket = require('../models/Ticket');
const Task = require('../models/Task');
const Announcement = require('../models/Announcement');
const Notification = require('../models/Notification');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { ROLES } = require('../constants');

const todayStr = () => dayjs().format('YYYY-MM-DD');

// Next occurrence (this year or next) of an anniversary-style date, on/after `start`.
const nextOccurrence = (date, start) => {
  let occ = dayjs(date).year(start.year());
  if (occ.isBefore(start, 'day')) occ = occ.add(1, 'year');
  return occ;
};

// DOBs + joining anniversaries (years >= 1) falling within the next 7 days.
const upcomingCelebrations = async (companyId) => {
  const employees = await Employee.find({ companyId, isDeleted: false, status: 'active' })
    .select('personal.firstName personal.lastName personal.dob job.joiningDate')
    .lean();
  const start = dayjs().startOf('day');
  const birthdays = [];
  const anniversaries = [];
  for (const e of employees) {
    const name = `${e.personal.firstName} ${e.personal.lastName || ''}`.trim();
    if (e.personal && e.personal.dob) {
      const occ = nextOccurrence(e.personal.dob, start);
      if (occ.diff(start, 'day') <= 7) {
        birthdays.push({ employeeId: e._id, name, date: occ.format('YYYY-MM-DD') });
      }
    }
    if (e.job && e.job.joiningDate) {
      const occ = nextOccurrence(e.job.joiningDate, start);
      const years = occ.year() - dayjs(e.job.joiningDate).year();
      if (years >= 1 && occ.diff(start, 'day') <= 7) {
        anniversaries.push({ employeeId: e._id, name, years, date: occ.format('YYYY-MM-DD') });
      }
    }
  }
  birthdays.sort((a, b) => a.date.localeCompare(b.date));
  anniversaries.sort((a, b) => a.date.localeCompare(b.date));
  return { birthdays, anniversaries };
};

const companyAdminStats = async (companyId) => {
  const date = todayStr();
  const [
    totalEmployees,
    fieldEmployees,
    presentToday,
    absentToday,
    lateToday,
    onLeaveToday,
    activeFieldVisits,
    completedVisitsToday,
    pendingVisitsToday,
    pendingLeaves,
    pendingCorrections,
    pendingPayroll,
    pendingDocuments,
    openTickets,
  ] = await Promise.all([
    Employee.countDocuments({ companyId, isDeleted: false, status: 'active' }),
    Employee.countDocuments({ companyId, isDeleted: false, status: 'active', 'job.employeeType': 'field_employee' }),
    Attendance.countDocuments({ companyId, date, status: { $in: ['present', 'late', 'early_exit', 'wfh', 'half_day'] } }),
    Attendance.countDocuments({ companyId, date, status: 'absent' }),
    Attendance.countDocuments({ companyId, date, status: 'late' }),
    Attendance.countDocuments({ companyId, date, status: 'on_leave' }),
    FieldVisit.countDocuments({ companyId, date, status: 'checked_in', checkOutTime: null }),
    FieldWorkAssignment.countDocuments({ companyId, date, status: { $in: ['completed', 'checked_out'] }, isDeleted: false }),
    FieldWorkAssignment.countDocuments({
      companyId,
      date,
      status: { $nin: ['completed', 'checked_out', 'cancelled', 'rejected'] },
      isDeleted: false,
    }),
    Leave.countDocuments({ companyId, status: 'pending' }),
    AttendanceCorrection.countDocuments({ companyId, status: { $in: ['pending', 'manager_approved'] } }),
    Payroll.countDocuments({ companyId, status: { $in: ['draft', 'under_review'] } }),
    EmployeeDocument.countDocuments({ companyId, status: 'pending', isDeleted: false }),
    Ticket.countDocuments({ companyId, status: { $in: ['open', 'in_progress'] }, isDeleted: false }),
  ]);

  const celebrations = await upcomingCelebrations(companyId);

  // ---- chart + feed datasets for the admin dashboard --------------------------
  const companyOid = new mongoose.Types.ObjectId(String(companyId));
  const sevenDays = [...Array(7)].map((_, i) => dayjs().subtract(6 - i, 'day').format('YYYY-MM-DD'));
  const weekRows = await Attendance.aggregate([
    { $match: { companyId: companyOid, date: { $in: sevenDays } } },
    { $group: { _id: { date: '$date', status: '$status' }, count: { $sum: 1 } } },
  ]);
  const weeklyAttendance = sevenDays.map((d) => {
    const row = { day: dayjs(d).format('ddd'), date: d, present: 0, absent: 0, late: 0 };
    for (const r of weekRows) {
      if (r._id.date !== d) continue;
      if (['present', 'wfh', 'half_day', 'early_exit'].includes(r._id.status)) row.present += r.count;
      else if (r._id.status === 'late') { row.late += r.count; row.present += r.count; }
      else if (r._id.status === 'absent') row.absent += r.count;
    }
    return row;
  });

  const deptRows = await Employee.aggregate([
    { $match: { companyId: companyOid, isDeleted: false, status: 'active' } },
    { $group: { _id: '$job.departmentId', count: { $sum: 1 } } },
  ]);
  const deptDocs = await Department.find({ _id: { $in: deptRows.map((r) => r._id).filter(Boolean) } }).select('name').lean();
  const deptNames = Object.fromEntries(deptDocs.map((d) => [String(d._id), d.name]));
  const departmentHeadcount = deptRows
    .map((r) => ({ name: r._id ? deptNames[String(r._id)] || 'Other' : 'Unassigned', count: r.count }))
    .sort((a, b) => b.count - a.count);

  const todaysVisits = await FieldVisit.find({ companyId, date })
    .populate('employeeId', 'personal.firstName personal.lastName')
    .populate('clientId', 'name')
    .sort({ updatedAt: -1 }).limit(10).lean();
  const fullName = (e) => (e && e.personal ? (e.personal.firstName + ' ' + (e.personal.lastName || '')).trim() : 'Employee');
  const fieldActivity = [];
  for (const v of todaysVisits) {
    const employeeName = fullName(v.employeeId);
    const clientName = v.clientId ? v.clientId.name : '';
    if (v.checkOutTime) fieldActivity.push({ employeeName, action: 'checked out', clientName, time: v.checkOutTime });
    if (v.checkInTime) fieldActivity.push({ employeeName, action: 'checked in', clientName, time: v.checkInTime });
  }
  fieldActivity.sort((a, b) => new Date(b.time) - new Date(a.time));

  const [pendingLeaveDocs, pendingCorrDocs] = await Promise.all([
    Leave.find({ companyId, status: 'pending' }).populate('employeeId', 'personal.firstName personal.lastName').sort({ createdAt: -1 }).limit(5).lean(),
    AttendanceCorrection.find({ companyId, status: 'pending' }).populate('employeeId', 'personal.firstName personal.lastName').sort({ createdAt: -1 }).limit(3).lean(),
  ]);
  const pendingApprovalsList = [
    ...pendingLeaveDocs.map((l) => ({ title: 'Leave — ' + (l.leaveType || 'request'), employeeName: fullName(l.employeeId), status: 'pending', createdAt: l.createdAt })),
    ...pendingCorrDocs.map((c) => ({ title: 'Attendance correction', employeeName: fullName(c.employeeId), status: 'pending', createdAt: c.createdAt })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);

  return {
    // flat aliases (the admin dashboard cards read these directly)
    totalEmployees,
    fieldEmployees,
    presentToday,
    absentToday,
    lateToday,
    activeFieldVisits,
    completedVisitsToday,
    pendingVisitsToday,
    pendingLeaves,
    pendingPayroll,
    weeklyAttendance,
    departmentHeadcount,
    fieldActivity,
    pendingApprovalsList,
    employees: {
      total: totalEmployees,
      field: fieldEmployees,
      office: totalEmployees - fieldEmployees,
    },
    attendanceToday: {
      present: presentToday,
      absent: absentToday,
      late: lateToday,
      onLeave: onLeaveToday,
      notMarked: Math.max(totalEmployees - presentToday - absentToday - onLeaveToday, 0),
    },
    fieldToday: {
      activeVisits: activeFieldVisits,
      completedVisits: completedVisitsToday,
      pendingVisits: pendingVisitsToday,
    },
    pendingApprovals: {
      leaves: pendingLeaves,
      corrections: pendingCorrections,
      payroll: pendingPayroll,
      documents: pendingDocuments,
      tickets: openTickets,
    },
    celebrations,
  };
};

const managerStats = async (companyId, managerEmployeeId) => {
  const date = todayStr();
  const team = await Employee.find({ companyId, 'job.managerId': managerEmployeeId, isDeleted: false }).select('_id').lean();
  const teamIds = team.map((t) => t._id);

  const [presentToday, lateToday, onLeaveToday, pendingLeaves, pendingCorrections, activeVisits, pendingVisits, completedVisits, openTasks] =
    await Promise.all([
      Attendance.countDocuments({ companyId, date, employeeId: { $in: teamIds }, status: { $in: ['present', 'late', 'early_exit', 'wfh', 'half_day'] } }),
      Attendance.countDocuments({ companyId, date, employeeId: { $in: teamIds }, status: 'late' }),
      Attendance.countDocuments({ companyId, date, employeeId: { $in: teamIds }, status: 'on_leave' }),
      Leave.countDocuments({ companyId, employeeId: { $in: teamIds }, status: 'pending' }),
      AttendanceCorrection.countDocuments({ companyId, employeeId: { $in: teamIds }, status: 'pending' }),
      FieldVisit.countDocuments({ companyId, date, employeeId: { $in: teamIds }, status: 'checked_in', checkOutTime: null }),
      FieldWorkAssignment.countDocuments({
        companyId,
        date,
        employeeId: { $in: teamIds },
        status: { $nin: ['completed', 'checked_out', 'cancelled', 'rejected'] },
        isDeleted: false,
      }),
      FieldWorkAssignment.countDocuments({ companyId, date, employeeId: { $in: teamIds }, status: { $in: ['completed', 'checked_out'] }, isDeleted: false }),
      Task.countDocuments({ companyId, assignedTo: { $in: teamIds }, status: { $in: ['todo', 'in_progress'] }, isDeleted: false }),
    ]);

  return {
    teamSize: teamIds.length,
    attendanceToday: { present: presentToday, late: lateToday, onLeave: onLeaveToday, notMarked: Math.max(teamIds.length - presentToday - onLeaveToday, 0) },
    fieldToday: { activeVisits, pendingVisits, completedVisits },
    pendingApprovals: { leaves: pendingLeaves, corrections: pendingCorrections },
    openTasks,
  };
};

const personalStats = async (companyId, employeeId, userId, isField) => {
  const date = todayStr();
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');

  const [attendanceToday, monthAttendance, myPendingLeaves, pendingLeaveItems, openTasks, unreadNotifications, announcements] = await Promise.all([
    Attendance.findOne({ companyId, employeeId, date }).lean(),
    Attendance.find({ companyId, employeeId, date: { $gte: monthStart, $lte: date } }).select('status').lean(),
    Leave.countDocuments({ companyId, employeeId, status: 'pending' }),
    Leave.find({ companyId, employeeId, status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('leaveType fromDate toDate days status createdAt')
      .lean(),
    Task.countDocuments({ companyId, assignedTo: employeeId, status: { $in: ['todo', 'in_progress'] }, isDeleted: false }),
    Notification.countDocuments({ userId, isRead: false }),
    Announcement.find({ companyId, isDeleted: false, isActive: true, publishAt: { $lte: new Date() } })
      .sort({ publishAt: -1 })
      .limit(5)
      .select('title publishAt')
      .lean(),
  ]);

  const monthCounts = { present: 0, late: 0, half_day: 0, absent: 0, on_leave: 0 };
  for (const a of monthAttendance) {
    if (monthCounts[a.status] !== undefined) monthCounts[a.status] += 1;
    else if (['early_exit', 'wfh'].includes(a.status)) monthCounts.present += 1;
  }

  const data = {
    attendanceToday,
    month: monthCounts,
    pendingLeaves: myPendingLeaves,
    pendingLeaveItems,
    openTasks,
    unreadNotifications,
    announcements,
  };

  if (isField && employeeId) {
    const [todayAssignments, activeVisit, completedToday] = await Promise.all([
      FieldWorkAssignment.find({ companyId, employeeId, date, isDeleted: false })
        .populate('clientId', 'name address location')
        .sort({ startTime: 1 })
        .lean(),
      FieldVisit.findOne({ companyId, employeeId, status: 'checked_in', checkOutTime: null }).lean(),
      FieldWorkAssignment.countDocuments({ companyId, employeeId, date, status: { $in: ['completed', 'checked_out'] }, isDeleted: false }),
    ]);
    data.field = {
      todayAssignments,
      activeVisit,
      completedToday,
      pendingToday: todayAssignments.filter((a) => !['completed', 'checked_out', 'cancelled', 'rejected'].includes(a.status)).length,
    };
  }
  return data;
};

// GET /dashboard — role-aware
const getDashboard = asyncHandler(async (req, res) => {
  const { role } = req.user;
  let data;
  if ([ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.PAYROLL_ADMIN, ROLES.SUPER_ADMIN].includes(role)) {
    const companyId = getCompanyId(req);
    data = await companyAdminStats(companyId);
  } else if (role === ROLES.MANAGER) {
    data = await managerStats(req.user.companyId, req.user.employeeId);
  } else {
    data = await personalStats(
      req.user.companyId,
      req.user.employeeId,
      req.user.userId,
      role === ROLES.FIELD_EMPLOYEE
    );
  }
  return ok(res, { role, ...data }, 'Dashboard');
});

module.exports = { getDashboard };
