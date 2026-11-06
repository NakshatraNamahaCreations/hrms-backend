/**
 * Derived facts about employees that the directory shows but no single
 * collection stores: the saved-view counts, the attention signals, the 30-day
 * attendance strip, profile completeness and key-person risk.
 *
 * Everything here is computed from data the product already has. Nothing is
 * invented: if a number cannot be derived it is not returned, so the UI can
 * leave the column out rather than show a plausible-looking zero.
 */
const dayjs = require('dayjs');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const Resignation = require('../models/Resignation');
const PerformanceReview = require('../models/PerformanceReview');

const WINDOW_DAYS = 30; // the strip shown on each row
const BASELINE_DAYS = 90; // the 60 days before the strip, used as the person's own baseline
const DRIFT_POINTS = 8; // attendance points away from baseline before we call it drift
const PROBATION_SOON_DAYS = 30;
const BIRTHDAY_WINDOW_DAYS = 7;

// Resignations that are still running — the employee is on notice, not gone.
const OPEN_RESIGNATION = { $nin: ['completed', 'rejected', 'withdrawn'] };

// Statuses that do not count toward an attendance rate: nobody was expected in.
const NOT_SCHEDULED = ['week_off', 'holiday'];
// Credit toward the rate. half_day is counted at half below.
const FULL_CREDIT = ['present', 'late', 'wfh', 'early_exit'];

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const idStr = (v) => String(v && v._id ? v._id : v);

// ---------------------------------------------------------------- completeness

/**
 * Fields a profile needs before payroll, statutory filing and ID cards work.
 * `bank` is excluded here because the list endpoint deliberately does not select
 * it — completeness is reported on what the directory can actually see.
 */
const REQUIRED_FIELDS = [
  { key: 'personal.phone', label: 'Phone' },
  { key: 'personal.dob', label: 'Date of birth' },
  { key: 'personal.gender', label: 'Gender' },
  { key: 'personal.address', label: 'Address' },
  { key: 'personal.emergencyContact.phone', label: 'Emergency contact' },
  { key: 'job.branchId', label: 'Branch' },
  { key: 'job.departmentId', label: 'Department' },
  { key: 'job.designationId', label: 'Designation' },
  { key: 'job.joiningDate', label: 'Joining date' },
  { key: 'job.managerId', label: 'Reporting manager' },
];

const dig = (obj, path) => path.split('.').reduce((a, k) => (a === null || a === undefined ? a : a[k]), obj);

function completeness(emp) {
  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = dig(emp, f.key);
    return v === null || v === undefined || v === '';
  });
  return {
    percent: Math.round(((REQUIRED_FIELDS.length - missing.length) / REQUIRED_FIELDS.length) * 100),
    missing: missing.map((f) => f.label),
  };
}

// A profile is "incomplete" once anything required is absent.
const isIncomplete = (emp) => completeness(emp).missing.length > 0;

// ---------------------------------------------------------------- attendance

const rateOf = (counts) => {
  const scheduled = Object.entries(counts)
    .filter(([s]) => !NOT_SCHEDULED.includes(s))
    .reduce((t, [, n]) => t + n, 0);
  if (!scheduled) return null; // no scheduled days => no rate, not 0%
  const credited = Object.entries(counts).reduce((t, [s, n]) => {
    if (FULL_CREDIT.includes(s)) return t + n;
    if (s === 'half_day') return t + n * 0.5;
    return t;
  }, 0);
  return (credited / scheduled) * 100;
};

/**
 * 30-day strip + rate + drift against the person's own previous 60 days.
 * Returns a Map keyed by employee id string.
 */
async function attendanceByEmployee(companyId, employeeIds) {
  const today = dayjs();
  const windowStart = today.subtract(WINDOW_DAYS - 1, 'day');
  const baselineStart = today.subtract(BASELINE_DAYS, 'day');
  const ids = employeeIds.map(oid);

  const [recent, baseline] = await Promise.all([
    Attendance.find({
      companyId,
      employeeId: { $in: ids },
      date: { $gte: windowStart.format('YYYY-MM-DD'), $lte: today.format('YYYY-MM-DD') },
    })
      .select('employeeId date status checkIn.time checkOut.time')
      .lean(),
    Attendance.aggregate([
      {
        $match: {
          companyId: oid(companyId),
          employeeId: { $in: ids },
          date: { $gte: baselineStart.format('YYYY-MM-DD'), $lt: windowStart.format('YYYY-MM-DD') },
        },
      },
      { $group: { _id: { e: '$employeeId', s: '$status' }, n: { $sum: 1 } } },
    ]),
  ]);

  const dates = [...Array(WINDOW_DAYS)].map((_, i) => windowStart.add(i, 'day').format('YYYY-MM-DD'));
  const byEmp = new Map();
  const ensure = (id) => {
    if (!byEmp.has(id)) byEmp.set(id, { byDate: {}, counts: {}, base: {}, unverified: 0 });
    return byEmp.get(id);
  };

  for (const r of recent) {
    const e = ensure(idStr(r.employeeId));
    e.byDate[r.date] = r.status;
    e.counts[r.status] = (e.counts[r.status] || 0) + 1;
    // A punch-in with no punch-out leaves the day's hours unprovable — the rate
    // is still shown, but flagged, rather than quietly treated as a full day.
    const hasIn = Boolean(r.checkIn && r.checkIn.time);
    const hasOut = Boolean(r.checkOut && r.checkOut.time);
    if (hasIn && !hasOut) e.unverified += 1;
  }
  for (const b of baseline) {
    const e = ensure(idStr(b._id.e));
    e.base[b._id.s] = (e.base[b._id.s] || 0) + b.n;
  }

  const out = new Map();
  for (const [id, e] of byEmp) {
    const percent = rateOf(e.counts);
    const basePercent = rateOf(e.base);
    let drift = null;
    if (percent !== null && basePercent !== null) {
      const delta = percent - basePercent;
      if (delta <= -DRIFT_POINTS) drift = 'down';
      else if (delta >= DRIFT_POINTS) drift = 'up';
    }
    out.set(id, {
      percent: percent === null ? null : Math.round(percent * 10) / 10,
      baselinePercent: basePercent === null ? null : Math.round(basePercent * 10) / 10,
      drift,
      unverified: e.unverified,
      // null marks a day with no record at all, which the UI greys out instead
      // of painting as an absence.
      days: dates.map((d) => ({ date: d, status: e.byDate[d] || null })),
    });
  }
  return out;
}

// ---------------------------------------------------------------- performance

/** Latest finalized rating per employee, with the change from the one before. */
async function ratingsByEmployee(companyId, employeeIds) {
  const reviews = await PerformanceReview.find({
    companyId,
    employeeId: { $in: employeeIds.map(oid) },
    status: 'finalized',
    finalRating: { $ne: null },
  })
    .select('employeeId finalRating finalizedAt cycleId')
    .sort({ finalizedAt: -1 })
    .lean();

  const byEmp = new Map();
  for (const r of reviews) {
    const id = idStr(r.employeeId);
    if (!byEmp.has(id)) byEmp.set(id, []);
    byEmp.get(id).push(r);
  }
  const out = new Map();
  for (const [id, list] of byEmp) {
    const [latest, previous] = list; // already newest-first
    out.set(id, {
      rating: latest.finalRating,
      delta: previous ? Math.round((latest.finalRating - previous.finalRating) * 10) / 10 : null,
      finalizedAt: latest.finalizedAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------- key person

/**
 * Employees who are the ONLY active holder of their designation. Losing them
 * leaves nobody doing that job — a bus factor of one, derived rather than
 * hand-flagged. Employees with no designation set are not counted.
 */
async function keyPersonIds(companyId) {
  const rows = await Employee.aggregate([
    { $match: { companyId: oid(companyId), isDeleted: false, status: 'active', 'job.designationId': { $ne: null } } },
    { $group: { _id: '$job.designationId', ids: { $push: '$_id' } } },
    { $match: { $expr: { $eq: [{ $size: '$ids' }, 1] } } },
  ]);
  return new Set(rows.map((r) => idStr(r.ids[0])));
}

// ---------------------------------------------------------------- notice period

/** Employees with an open resignation, mapped to their last working day. */
async function noticeMap(companyId) {
  const rows = await Resignation.find({ companyId, status: OPEN_RESIGNATION })
    .select('employeeId lastWorkingDate resignationDate noticePeriodDays status')
    .lean();
  const out = new Map();
  for (const r of rows) out.set(idStr(r.employeeId), r);
  return out;
}

// ---------------------------------------------------------------- birthdays

const mmdd = (d) => dayjs(d).format('MM-DD');

/** MM-DD strings for today through today + n days, wrapping across new year. */
function upcomingMmdd(days) {
  const t = dayjs();
  return [...Array(days + 1)].map((_, i) => mmdd(t.add(i, 'day')));
}

// ---------------------------------------------------------------- views

/**
 * The saved views down the top of the directory. `notice` and `incomplete`
 * cannot be expressed as a plain mongo filter, so they resolve to an id list.
 */
async function viewScope(companyId, view) {
  switch (view) {
    case 'active':
      return { filter: { status: 'active', 'job.confirmationStatus': { $ne: 'probation' } } };
    case 'probation':
      return { filter: { status: 'active', 'job.confirmationStatus': 'probation' } };
    case 'exited':
      return { filter: { status: 'exited' } };
    case 'notice': {
      const notice = await noticeMap(companyId);
      return { filter: { status: { $ne: 'exited' } }, ids: [...notice.keys()] };
    }
    case 'incomplete': {
      const docs = await Employee.find({ companyId, isDeleted: false, status: { $ne: 'exited' } })
        .select(REQUIRED_FIELDS.map((f) => f.key).join(' '))
        .lean();
      return { filter: { status: { $ne: 'exited' } }, ids: docs.filter(isIncomplete).map((d) => idStr(d._id)) };
    }
    case 'all':
    default:
      return { filter: { status: { $ne: 'exited' } } };
  }
}

// ---------------------------------------------------------------- overview

/** Counts for every view and every signal, in one pass over the company. */
async function overview(companyId) {
  const base = { companyId, isDeleted: false };
  const docs = await Employee.find(base)
    .select(`status job.confirmationStatus job.designationId personal.dob job.probationEndDate ${REQUIRED_FIELDS.map((f) => f.key).join(' ')}`)
    .lean();

  const notActive = (e) => e.status === 'exited';
  const onPayroll = docs.filter((e) => !notActive(e));

  const [notice, keyPersons] = await Promise.all([noticeMap(companyId), keyPersonIds(companyId)]);
  const attendance = await attendanceByEmployee(companyId, onPayroll.map((e) => e._id));

  const birthdayWindow = new Set(upcomingMmdd(BIRTHDAY_WINDOW_DAYS));
  const probationCutoff = dayjs().add(PROBATION_SOON_DAYS, 'day');

  const views = {
    all: onPayroll.length,
    active: docs.filter((e) => e.status === 'active' && (e.job || {}).confirmationStatus !== 'probation').length,
    probation: docs.filter((e) => e.status === 'active' && (e.job || {}).confirmationStatus === 'probation').length,
    notice: onPayroll.filter((e) => notice.has(idStr(e._id))).length,
    incomplete: onPayroll.filter(isIncomplete).length,
    exited: docs.filter((e) => e.status === 'exited').length,
  };

  let driftDown = 0;
  let driftUp = 0;
  let lowConfidence = 0;
  for (const e of onPayroll) {
    const a = attendance.get(idStr(e._id));
    if (!a) continue;
    if (a.drift === 'down') driftDown += 1;
    if (a.drift === 'up') driftUp += 1;
    if (a.unverified > 0) lowConfidence += 1;
  }

  const signals = {
    driftDown,
    driftUp,
    lowConfidence,
    keyPerson: onPayroll.filter((e) => keyPersons.has(idStr(e._id))).length,
    probationDue: docs.filter(
      (e) =>
        e.status === 'active' &&
        (e.job || {}).confirmationStatus === 'probation' &&
        (e.job || {}).probationEndDate &&
        dayjs((e.job || {}).probationEndDate).isBefore(probationCutoff)
    ).length,
    birthdaysWeek: onPayroll.filter((e) => (e.personal || {}).dob && birthdayWindow.has(mmdd(e.personal.dob))).length,
  };

  return { views, signals, windowDays: WINDOW_DAYS, baselineDays: BASELINE_DAYS, driftPoints: DRIFT_POINTS };
}

// ---------------------------------------------------------------- signal filters

/**
 * Resolves the signal query params to an id list, or null when none are active.
 * Several signals intersect (an id must satisfy all of them).
 *
 * These are derived, not indexed, so every active signal scans the company.
 * Fine at directory scale; a company in the tens of thousands would want these
 * precomputed on a schedule instead.
 */
async function signalIds(companyId, q) {
  const sets = [];

  if (q.drift === 'down' || q.drift === 'up' || q.lowConfidence === '1' || q.lowConfidence === 'true') {
    const onPayroll = await Employee.find({ companyId, isDeleted: false, status: { $ne: 'exited' } }).select('_id').lean();
    const att = await attendanceByEmployee(companyId, onPayroll.map((e) => e._id));
    if (q.drift === 'down' || q.drift === 'up') {
      sets.push(new Set([...att].filter(([, a]) => a.drift === q.drift).map(([id]) => id)));
    }
    if (q.lowConfidence === '1' || q.lowConfidence === 'true') {
      sets.push(new Set([...att].filter(([, a]) => a.unverified > 0).map(([id]) => id)));
    }
  }

  if (q.keyPerson === '1' || q.keyPerson === 'true') sets.push(await keyPersonIds(companyId));

  if (q.birthday === 'week') {
    const window = new Set(upcomingMmdd(BIRTHDAY_WINDOW_DAYS));
    const docs = await Employee.find({ companyId, isDeleted: false, 'personal.dob': { $ne: null } }).select('personal.dob').lean();
    sets.push(new Set(docs.filter((d) => window.has(mmdd(d.personal.dob))).map((d) => idStr(d._id))));
  }

  if (q.probationDue === '1' || q.probationDue === 'true') {
    const cutoff = dayjs().add(PROBATION_SOON_DAYS, 'day').toDate();
    const docs = await Employee.find({
      companyId,
      isDeleted: false,
      status: 'active',
      'job.confirmationStatus': 'probation',
      'job.probationEndDate': { $ne: null, $lt: cutoff },
    })
      .select('_id')
      .lean();
    sets.push(new Set(docs.map((d) => idStr(d._id))));
  }

  if (!sets.length) return null;
  return [...sets.reduce((acc, s) => new Set([...acc].filter((x) => s.has(x))))];
}

// ---------------------------------------------------------------- row enrichment

/**
 * Adds the derived columns to a page of employees.
 * `includePerformance` is false for roles that may not see ratings — the key is
 * then absent from the row rather than present and null, so the client can tell
 * "not allowed to see" apart from "not rated yet".
 */
async function enrich(companyId, employees, { includePerformance = false } = {}) {
  if (!employees.length) return employees;
  const ids = employees.map((e) => e._id);

  const [attendance, notice, keyPersons, ratings] = await Promise.all([
    attendanceByEmployee(companyId, ids),
    noticeMap(companyId),
    keyPersonIds(companyId),
    includePerformance ? ratingsByEmployee(companyId, ids) : Promise.resolve(new Map()),
  ]);

  const window = new Set(upcomingMmdd(BIRTHDAY_WINDOW_DAYS));

  return employees.map((e) => {
    const id = idStr(e._id);
    const res = notice.get(id);
    const dob = (e.personal || {}).dob;
    return {
      ...e,
      attendance30: attendance.get(id) || null,
      ...(includePerformance ? { performance: ratings.get(id) || null } : {}),
      completeness: completeness(e),
      keyPerson: keyPersons.has(id),
      notice: res ? { lastWorkingDate: res.lastWorkingDate, status: res.status } : null,
      birthdayThisWeek: Boolean(dob && window.has(mmdd(dob))),
    };
  });
}

module.exports = {
  overview,
  viewScope,
  signalIds,
  enrich,
  completeness,
  REQUIRED_FIELDS,
  WINDOW_DAYS,
};
