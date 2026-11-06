const dayjs = require('dayjs');
const FieldVisit = require('../models/FieldVisit');
const FieldWorkAssignment = require('../models/FieldWorkAssignment');
const FieldLocationLog = require('../models/FieldLocationLog');
const Attendance = require('../models/Attendance');
const { haversineMeters } = require('../utils/geo');

/**
 * Derives day attendance for a field employee from their field visits:
 * first check-in of the day = attendance check-in, last checkout = check-out.
 * Upserted with attendanceSource 'field_visit'.
 */
const upsertDayAttendance = async (companyId, employeeId, date) => {
  const visits = await FieldVisit.find({ companyId, employeeId, date, checkInTime: { $ne: null } })
    .sort({ checkInTime: 1 })
    .lean();
  if (!visits.length) return null;

  const first = visits[0];
  const checkOuts = visits.filter((v) => v.checkOutTime).map((v) => v.checkOutTime);
  const lastOut = checkOuts.length ? new Date(Math.max(...checkOuts.map((d) => new Date(d).getTime()))) : null;

  let totalHours = 0;
  let workMinutes = 0;
  if (lastOut) {
    workMinutes = Math.max(Math.round((lastOut - new Date(first.checkInTime)) / 60000), 0);
    totalHours = Math.round((workMinutes / 60) * 100) / 100;
  }

  const existing = await Attendance.findOne({ companyId, employeeId, date });
  if (existing && existing.isLocked) return existing;

  const status = lastOut && totalHours < 4 ? 'half_day' : 'present';

  const update = {
    companyId,
    employeeId,
    date,
    status,
    attendanceSource: 'field_visit',
    checkIn: {
      time: first.checkInTime,
      location: first.checkInLocation
        ? { latitude: first.checkInLocation.latitude, longitude: first.checkInLocation.longitude }
        : undefined,
      source: 'field_visit',
    },
    totalHours,
    workMinutes,
  };
  if (lastOut) {
    const lastVisit = visits.filter((v) => v.checkOutTime).pop();
    update.checkOut = {
      time: lastOut,
      location:
        lastVisit && lastVisit.checkOutLocation
          ? { latitude: lastVisit.checkOutLocation.latitude, longitude: lastVisit.checkOutLocation.longitude }
          : undefined,
      source: 'field_visit',
    };
  }

  return Attendance.findOneAndUpdate(
    { companyId, employeeId, date },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/**
 * Daily field summary for an employee.
 */
const dailySummary = async (companyId, employeeId, date) => {
  const [assignments, visits, logs] = await Promise.all([
    // multi-day jobs: everything active on this date (started on/before, not cancelled)
    FieldWorkAssignment.find({
      companyId,
      employeeId,
      date: { $lte: date },
      status: { $nin: ['cancelled', 'rejected'] },
      isDeleted: false,
    }).lean(),
    FieldVisit.find({ companyId, employeeId, date }).lean(),
    FieldLocationLog.find({
      companyId,
      employeeId,
      capturedAt: {
        $gte: dayjs(date).startOf('day').toDate(),
        $lte: dayjs(date).endOf('day').toDate(),
      },
    })
      .sort({ capturedAt: 1 })
      .select('latitude longitude capturedAt')
      .lean(),
  ]);

  const totalVisits = assignments.length;
  const completedVisits = assignments.filter((a) => ['completed', 'checked_out'].includes(a.status)).length;
  const pendingVisits = assignments.filter(
    (a) => !['completed', 'checked_out', 'cancelled', 'rejected'].includes(a.status)
  ).length;
  const totalWorkMinutes = visits.reduce((sum, v) => sum + (v.totalWorkMinutes || 0), 0);

  let distanceMeters = 0;
  for (let i = 1; i < logs.length; i += 1) {
    distanceMeters += haversineMeters(
      logs[i - 1].latitude,
      logs[i - 1].longitude,
      logs[i].latitude,
      logs[i].longitude
    );
  }

  let travelMinutes = 0;
  if (logs.length > 1) {
    const spanMinutes = Math.round((new Date(logs[logs.length - 1].capturedAt) - new Date(logs[0].capturedAt)) / 60000);
    travelMinutes = Math.max(spanMinutes - totalWorkMinutes, 0);
  }

  const checkIns = visits
    .filter((v) => v.checkInTime)
    .sort((a, b) => new Date(a.checkInTime) - new Date(b.checkInTime));
  const checkOuts = visits.filter((v) => v.checkOutTime);
  const active = visits.find((v) => v.status === 'checked_in') || null;

  return {
    date,
    totalVisits,
    completedVisits,
    pendingVisits,
    totalWorkMinutes,
    travelMinutes,
    totalDistanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
    daysWorked: visits.length ? 1 : 0,
    firstCheckInTime: checkIns.length ? checkIns[0].checkInTime : null,
    lastCheckOutTime: checkOuts.length
      ? checkOuts.sort((a, b) => new Date(b.checkOutTime) - new Date(a.checkOutTime))[0].checkOutTime
      : null,
    activeVisit: active
      ? {
          _id: active._id,
          workAssignmentId: active.workAssignmentId,
          clientId: active.clientId,
          checkInTime: active.checkInTime,
        }
      : null,
  };
};

/**
 * Field summary over a date range — single employee (employeeId given) or
 * company-wide (employeeId null). Same shape as dailySummary; daysWorked =
 * distinct visit dates in the range.
 */
const rangeSummary = async (companyId, { employeeId = null, from, to }) => {
  const empFilter = employeeId ? { employeeId } : {};
  const [assignments, visits, logs] = await Promise.all([
    FieldWorkAssignment.find({
      companyId,
      ...empFilter,
      date: { $gte: from, $lte: to },
      status: { $nin: ['cancelled', 'rejected'] },
      isDeleted: false,
    }).lean(),
    FieldVisit.find({ companyId, ...empFilter, date: { $gte: from, $lte: to } }).lean(),
    FieldLocationLog.find({
      companyId,
      ...empFilter,
      capturedAt: {
        $gte: dayjs(from).startOf('day').toDate(),
        $lte: dayjs(to).endOf('day').toDate(),
      },
    })
      .sort({ employeeId: 1, capturedAt: 1 })
      .select('employeeId latitude longitude capturedAt')
      .lean(),
  ]);

  const totalVisits = assignments.length;
  const completedVisits = assignments.filter((a) => ['completed', 'checked_out'].includes(a.status)).length;
  const pendingVisits = assignments.filter(
    (a) => !['completed', 'checked_out', 'cancelled', 'rejected'].includes(a.status)
  ).length;
  const totalWorkMinutes = visits.reduce((sum, v) => sum + (v.totalWorkMinutes || 0), 0);

  // distance chains consecutive points only within the same employee-day
  let distanceMeters = 0;
  const spans = new Map(); // `${employeeId}|${date}` → { first, last }
  let prev = null;
  for (const log of logs) {
    const key = `${log.employeeId}|${dayjs(log.capturedAt).format('YYYY-MM-DD')}`;
    if (prev && prev.key === key) {
      distanceMeters += haversineMeters(prev.latitude, prev.longitude, log.latitude, log.longitude);
    }
    const span = spans.get(key);
    if (!span) spans.set(key, { first: log.capturedAt, last: log.capturedAt });
    else span.last = log.capturedAt;
    prev = { key, latitude: log.latitude, longitude: log.longitude };
  }

  // travel = tracked span minus work minutes, summed per employee-day
  const workByKey = new Map();
  for (const v of visits) {
    const key = `${v.employeeId}|${v.date}`;
    workByKey.set(key, (workByKey.get(key) || 0) + (v.totalWorkMinutes || 0));
  }
  let travelMinutes = 0;
  for (const [key, span] of spans) {
    const spanMinutes = Math.round((new Date(span.last) - new Date(span.first)) / 60000);
    travelMinutes += Math.max(spanMinutes - (workByKey.get(key) || 0), 0);
  }

  const checkIns = visits
    .filter((v) => v.checkInTime)
    .sort((a, b) => new Date(a.checkInTime) - new Date(b.checkInTime));
  const checkOuts = visits.filter((v) => v.checkOutTime);
  const active = employeeId ? visits.find((v) => v.status === 'checked_in') || null : null;

  return {
    from,
    to,
    totalVisits,
    completedVisits,
    pendingVisits,
    totalWorkMinutes,
    travelMinutes,
    totalDistanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
    daysWorked: new Set(visits.map((v) => v.date)).size,
    firstCheckInTime: checkIns.length ? checkIns[0].checkInTime : null,
    lastCheckOutTime: checkOuts.length
      ? checkOuts.sort((a, b) => new Date(b.checkOutTime) - new Date(a.checkOutTime))[0].checkOutTime
      : null,
    activeVisit: active
      ? {
          _id: active._id,
          workAssignmentId: active.workAssignmentId,
          clientId: active.clientId,
          checkInTime: active.checkInTime,
        }
      : null,
  };
};

module.exports = { upsertDayAttendance, dailySummary, rangeSummary };
