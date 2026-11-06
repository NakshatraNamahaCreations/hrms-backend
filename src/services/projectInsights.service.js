/**
 * Everything the Projects workspace shows that is not stored on a row: progress,
 * schedule and budget health, the forecast finish, what is waiting on the
 * client, and whether a logged timesheet agrees with the punch record.
 *
 * Health is computed here, on the server, so the list, the detail header and
 * the "how is this worked out" popover can never disagree with each other.
 */
const dayjs = require('dayjs');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectModuleItem = require('../models/ProjectModuleItem');
const Task = require('../models/Task');
const Timesheet = require('../models/Timesheet');
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const Leave = require('../models/Leave');

const STALE_APPROVAL_DAYS = 5; // how long a client may hold an approval before it is a problem
const SCHEDULE_AMBER = 10; // points of work-behind-time before "at risk"
const SCHEDULE_RED = 20;
const BURN_AMBER = 10; // points of budget-ahead-of-work before "at risk"
const BURN_RED = 20;
const OVERBOOKED_PCT = 110;
const UPCOMING_DAYS = 30;
const LEAVE_LOOKAHEAD_DAYS = 14;
const STANDARD_MONTH_HOURS = 8 * 22; // contracted hours used as the utilisation denominator

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const idStr = (v) => String(v && v._id ? v._id : v);
const today = () => dayjs().startOf('day');
const daysUntil = (d) => (d ? dayjs(d).startOf('day').diff(today(), 'day') : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round = (v) => Math.round(v);

// Module item states that mean the row is finished and should stop nagging.
const DONE_STATES = ['completed', 'delivered', 'done', 'received', 'installed', 'filed', 'closed', 'approved', 'valid', 'met', 'confirmed'];
const isDone = (item) => Boolean(item.completedAt) || DONE_STATES.includes(String(item.status || '').toLowerCase());
// Items whose money never lands on the project.
const VOID_STATES = ['rejected', 'cancelled', 'withdrawn'];

// ---------------------------------------------------------------- progress

/**
 * Work done, 0–100. Task completion is the truth when a project has tasks,
 * because it is maintained by the people doing the work; `progressOverride`
 * covers projects run without tasks, and a completed project is 100 by
 * definition.
 */
function progressOf(project, taskStats) {
  if (project.status === 'completed') return 100;
  if (taskStats && taskStats.total > 0) {
    return round((taskStats.done / taskStats.total) * 100);
  }
  if (project.progressOverride !== null && project.progressOverride !== undefined) {
    return round(project.progressOverride);
  }
  // No tasks and nothing set: fall back to how far through the phases it is.
  const n = (project.phases || []).length;
  if (!n) return 0;
  return round(((project.currentPhase || 0) / n) * 100);
}

/**
 * Percent of the planned calendar consumed, with client-hold and project-hold
 * time removed. A team is not behind because the client sat on an approval.
 */
function timeOf(project, clientWaitDays) {
  if (!project.startDate || !project.endDate) return { timePct: 0, elapsed: 0, duration: 0 };
  const start = dayjs(project.startDate).startOf('day');
  const end = dayjs(project.endDate).startOf('day');
  const duration = Math.max(1, end.diff(start, 'day'));
  const rawElapsed = Math.max(0, Math.min(today().diff(start, 'day'), duration + 365));
  const excluded = (clientWaitDays || 0) + (project.holdDays || 0);
  const elapsed = Math.max(0, rawElapsed - excluded);
  return { timePct: round((elapsed / duration) * 100), elapsed, duration, rawElapsed, excluded };
}

// ---------------------------------------------------------------- money

/**
 * Cost to date, split into people and everything else.
 *
 * People cost is approved timesheet hours priced at the employee's own hourly
 * cost rate, derived from CTC. Other cost is the committed value of module
 * items that represent real spend — purchase orders and vendor bookings.
 */
async function costOf(companyId, projectIds, workingDaysPerMonth) {
  const [labour, other] = await Promise.all([
    Timesheet.aggregate([
      { $match: { companyId: oid(companyId), projectId: { $in: projectIds.map(oid) }, status: { $ne: 'rejected' } } },
      { $group: { _id: { p: '$projectId', e: '$employeeId' }, hours: { $sum: '$hours' } } },
    ]),
    ProjectModuleItem.aggregate([
      {
        $match: {
          companyId: oid(companyId),
          projectId: { $in: projectIds.map(oid) },
          module: { $in: ['materials', 'vendors'] },
          isDeleted: false,
          status: { $nin: VOID_STATES },
        },
      },
      { $group: { _id: '$projectId', amount: { $sum: '$amount' } } },
    ]),
  ]);

  const empIds = [...new Set(labour.map((r) => idStr(r._id.e)))];
  const emps = await Employee.find({ _id: { $in: empIds.map(oid) } }).select('salary.ctc').lean();
  // Hourly cost from CTC: monthly cost over the company's working days, over 8h.
  const rate = new Map(
    emps.map((e) => [idStr(e._id), ((e.salary && e.salary.ctc) || 0) / 12 / (workingDaysPerMonth || 26) / 8])
  );

  const out = new Map();
  const bump = (pid, key, value) => {
    const k = idStr(pid);
    if (!out.has(k)) out.set(k, { labour: 0, other: 0, hours: 0 });
    out.get(k)[key] += value;
  };
  for (const r of labour) {
    bump(r._id.p, 'labour', r.hours * (rate.get(idStr(r._id.e)) || 0));
    bump(r._id.p, 'hours', r.hours);
  }
  for (const r of other) bump(r._id, 'other', r.amount);
  for (const v of out.values()) {
    v.labour = round(v.labour);
    v.other = round(v.other);
  }
  return out;
}

// ---------------------------------------------------------------- client holds

/** Approvals sitting with the client, newest wait first. */
async function waitingByProject(companyId, projectIds) {
  const rows = await ProjectModuleItem.find({
    companyId,
    projectId: { $in: projectIds.map(oid) },
    module: 'approvals',
    isDeleted: false,
    sentOn: { $ne: null },
    decidedOn: null,
  })
    .select('projectId title sentOn data')
    .lean();

  const out = new Map();
  for (const r of rows) {
    const k = idStr(r.projectId);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({
      id: idStr(r._id),
      name: r.title,
      version: (r.data && r.data.version) || null,
      sentOn: r.sentOn,
      days: Math.max(0, -daysUntil(r.sentOn)),
    });
  }
  for (const list of out.values()) list.sort((a, b) => b.days - a.days);
  return out;
}

// ---------------------------------------------------------------- health

/**
 * Three signals, worst wins:
 *   schedule  work done minus time used
 *   burn      budget used minus work done
 *   client    the oldest approval still with the client
 * The reasons are returned with the level so the UI never re-derives them.
 */
function healthOf(p) {
  if (p.status === 'completed') return { level: 'grey', label: 'Completed', reasons: [], gap: 0, burnGap: 0 };
  if (p.status === 'on_hold') return { level: 'grey', label: 'On hold', reasons: [], gap: 0, burnGap: 0 };

  const gap = p.progress - Math.min(100, p.timePct);
  const burnGap = p.budget > 0 ? p.burnPct - p.progress : 0;
  const reasons = [];
  let level = 'green';
  const bump = (l) => { if (l === 'red' || (l === 'amber' && level === 'green')) level = l; };

  const overdueBy = p.endDate ? -daysUntil(p.endDate) : null;
  if (overdueBy !== null && overdueBy > 0) {
    bump('red');
    reasons.push({
      short: `${overdueBy} ${overdueBy === 1 ? 'day' : 'days'} past finish`,
      long: `Planned finish was ${dayjs(p.endDate).format('DD MMM YYYY')} and work is ${p.progress}% done.`,
    });
  }
  if (gap <= -SCHEDULE_RED) {
    bump('red');
    reasons.push({ short: `${-gap} pts behind schedule`, long: `${Math.min(100, p.timePct)}% of the time is used but only ${p.progress}% of the work is done.` });
  } else if (gap <= -SCHEDULE_AMBER) {
    bump('amber');
    reasons.push({ short: `${-gap} pts behind schedule`, long: `Work is ${-gap} points behind the time used.` });
  }
  if (burnGap >= BURN_RED) {
    bump('red');
    reasons.push({ short: `Spending ${burnGap} pts ahead of work`, long: `${p.burnPct}% of the budget is spent for ${p.progress}% of the work. Forecast margin is ${p.margin}%.` });
  } else if (burnGap >= BURN_AMBER) {
    bump('amber');
    reasons.push({ short: `Spending ${burnGap} pts ahead of work`, long: 'Budget is being used faster than work is being completed.' });
  }
  const oldest = p.waiting && p.waiting[0];
  if (oldest && oldest.days >= STALE_APPROVAL_DAYS) {
    bump('amber');
    reasons.push({
      short: `Client sign-off waiting ${oldest.days} days`,
      long: `“${oldest.name}” has waited ${oldest.days} days for the client. That wait is excluded from the schedule.`,
    });
  }
  return { level, reasons, gap, burnGap };
}

// ---------------------------------------------------------------- enrichment

/** Task counts per project, used for progress and the items tab badge. */
async function taskStats(companyId, projectIds) {
  const rows = await Task.aggregate([
    { $match: { companyId: oid(companyId), projectId: { $in: projectIds.map(oid) }, isDeleted: false } },
    { $group: { _id: { p: '$projectId', s: '$status' }, n: { $sum: 1 } } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const k = idStr(r._id.p);
    if (!out.has(k)) out.set(k, { total: 0, done: 0, overdue: 0 });
    const e = out.get(k);
    e.total += r.n;
    if (r._id.s === 'completed') e.done += r.n;
  }
  return out;
}

/** Counts per module, plus how many rows in it need attention. */
async function moduleStats(companyId, projectIds) {
  const rows = await ProjectModuleItem.find({
    companyId,
    projectId: { $in: projectIds.map(oid) },
    isDeleted: false,
  })
    .select('projectId module status dueDate sentOn decidedOn completedAt')
    .lean();

  const out = new Map();
  for (const r of rows) {
    const k = idStr(r.projectId);
    if (!out.has(k)) out.set(k, {});
    const byMod = out.get(k);
    if (!byMod[r.module]) byMod[r.module] = { n: 0, alert: 0 };
    byMod[r.module].n += 1;
    const done = isDone(r);
    const overdue = !done && r.dueDate && daysUntil(r.dueDate) < 0;
    const stale = r.sentOn && !r.decidedOn && Math.max(0, -daysUntil(r.sentOn)) >= STALE_APPROVAL_DAYS;
    if (overdue || stale) byMod[r.module].alert += 1;
  }
  return out;
}

/**
 * Attaches every derived field to a page of projects. One round of queries for
 * the whole page, not one per row.
 */
async function enrich(companyId, projects, { workingDaysPerMonth = 26 } = {}) {
  if (!projects.length) return [];
  const ids = projects.map((p) => p._id);

  const [tasks, costs, waiting, mods, tsFlags] = await Promise.all([
    taskStats(companyId, ids),
    costOf(companyId, ids, workingDaysPerMonth),
    waitingByProject(companyId, ids),
    moduleStats(companyId, ids),
    timesheetFlagCounts(companyId, ids),
  ]);

  return projects.map((raw) => {
    const p = { ...raw };
    const key = idStr(p._id);
    const t = tasks.get(key) || { total: 0, done: 0 };
    const c = costs.get(key) || { labour: 0, other: 0, hours: 0 };
    const w = waiting.get(key) || [];

    p.progress = progressOf(p, t);
    p.clientWaitDays = w.reduce((a, x) => Math.max(a, x.days), 0);
    const time = timeOf(p, p.clientWaitDays);
    p.timePct = time.timePct;

    p.costSplit = { labour: c.labour, other: c.other };
    p.cost = c.labour + c.other;
    p.loggedHours = round(c.hours * 10) / 10;
    p.burnPct = p.budget > 0 ? round((p.cost / p.budget) * 100) : 0;
    // Forecast cost assumes the remaining work costs what the work so far did.
    p.forecastCost = p.progress > 5 ? round(p.cost / (p.progress / 100)) : p.budget;
    p.margin = p.contractValue > 0 ? round(((p.contractValue - p.forecastCost) / p.contractValue) * 100) : 0;

    // Forecast finish: stretch the elapsed working time by the pace of work,
    // then add back the days nobody could work.
    if (p.startDate && p.endDate) {
      const stretched = p.progress > 5 ? round(time.elapsed / (p.progress / 100)) : time.duration;
      p.forecastEnd = dayjs(p.startDate).add(Math.max(stretched, time.elapsed) + time.excluded, 'day').toDate();
    } else {
      p.forecastEnd = p.endDate || null;
    }

    p.waiting = w;
    p.taskStats = t;
    p.moduleStats = mods.get(key) || {};
    p.tsMismatch = tsFlags.get(key) || 0;
    p.health = healthOf(p);
    p.next = nextMilestone(p);
    return p;
  });
}

/** The next gate sign-off, or failing that the next phase to start. */
function nextMilestone(p) {
  if (p.status !== 'active') return null;
  const phases = p.phases || [];
  const from = p.currentPhase || 0;
  const gate = phases.findIndex((ph, i) => i >= from && ph.gate && !ph.signedOffAt);
  const idx = gate >= 0 ? gate : Math.min(from + 1, phases.length - 1);
  const phase = phases[idx];
  if (!phase) return null;
  const date = gate >= 0 ? phase.endDate : phase.startDate;
  if (!date) return null;
  const days = daysUntil(date);
  // Don't say "Client sign-off sign-off" when the phase is already named for it.
  const needsSuffix = gate >= 0 && !/sign[- ]?off|approval/i.test(phase.name);
  return {
    label: needsSuffix ? `${phase.name} sign-off` : phase.name,
    date,
    days,
    overdue: days < 0,
    gate: gate >= 0,
  };
}

// ---------------------------------------------------------------- timesheets

/**
 * Checks a logged entry against the punch record for that day.
 *
 * Time booked on a leave or absent day, or beyond the hours the person was
 * actually present, is flagged before it can reach a client invoice or feed a
 * cost figure. Returns null when the entry agrees with attendance.
 */
function reconcile(entry, attendance, alreadyLogged = 0) {
  if (!attendance) return { flag: 'No attendance record for that day', attendance: null };
  const st = attendance.status;
  if (st === 'on_leave') return { flag: 'Logged on an approved leave day', attendance };
  if (st === 'absent') return { flag: 'No punch-in that day', attendance };
  if (st === 'week_off' || st === 'holiday') {
    return { flag: `Logged on a ${st === 'holiday' ? 'holiday' : 'weekly off'}`, attendance };
  }
  const present = attendance.totalHours || 0;
  if (present > 0 && alreadyLogged + entry.hours > present + 0.25) {
    return {
      flag: `Logged ${round((alreadyLogged + entry.hours) * 10) / 10}h against ${round(present * 10) / 10}h present`,
      attendance,
    };
  }
  return { flag: null, attendance };
}

/** How many non-rejected entries on each project disagree with attendance. */
async function timesheetFlagCounts(companyId, projectIds) {
  const entries = await Timesheet.find({
    companyId,
    projectId: { $in: projectIds.map(oid) },
    status: { $ne: 'rejected' },
  })
    .select('projectId employeeId date hours')
    .lean();
  if (!entries.length) return new Map();

  const att = await attendanceIndex(companyId, entries);
  const loggedPerDay = dayTotals(entries);
  const out = new Map();
  for (const e of entries) {
    const key = `${idStr(e.employeeId)}|${e.date}`;
    const before = loggedPerDay.get(key) - e.hours; // this entry's share is added by reconcile
    const { flag } = reconcile(e, att.get(key), Math.max(0, before));
    if (flag) out.set(idStr(e.projectId), (out.get(idStr(e.projectId)) || 0) + 1);
  }
  return out;
}

/** employeeId|date → attendance row, for the days these entries touch. */
async function attendanceIndex(companyId, entries) {
  const dates = [...new Set(entries.map((e) => e.date))];
  const empIds = [...new Set(entries.map((e) => idStr(e.employeeId)))];
  const rows = await Attendance.find({
    companyId,
    employeeId: { $in: empIds.map(oid) },
    date: { $in: dates },
  })
    .select('employeeId date status totalHours checkIn.time checkOut.time')
    .lean();
  return new Map(rows.map((r) => [`${idStr(r.employeeId)}|${r.date}`, r]));
}

/** employeeId|date → total hours logged that day across every project. */
function dayTotals(entries) {
  const m = new Map();
  for (const e of entries) {
    const k = `${idStr(e.employeeId)}|${e.date}`;
    m.set(k, (m.get(k) || 0) + e.hours);
  }
  return m;
}

/** The timesheets tab: every entry with its attendance verdict and cost. */
async function timesheetsFor(companyId, projectId, workingDaysPerMonth) {
  const entries = await Timesheet.find({ companyId, projectId })
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName job.designationId salary.ctc')
    .populate({ path: 'employeeId', populate: { path: 'job.designationId', select: 'name' } })
    .sort({ date: -1 })
    .lean();
  if (!entries.length) return { rows: [], totals: { hours: 0, billable: 0, cost: 0, flagged: 0 } };

  const att = await attendanceIndex(companyId, entries);
  // Day totals must span every project, or a second project's hours look free.
  const sameDays = await Timesheet.find({
    companyId,
    employeeId: { $in: [...new Set(entries.map((e) => idStr(e.employeeId && e.employeeId._id)))].map(oid) },
    date: { $in: [...new Set(entries.map((e) => e.date))] },
    status: { $ne: 'rejected' },
  })
    .select('employeeId date hours projectId')
    .lean();
  const totals = dayTotals(sameDays);

  const rows = entries.map((e) => {
    const emp = e.employeeId || {};
    const key = `${idStr(emp._id)}|${e.date}`;
    const before = (totals.get(key) || e.hours) - e.hours;
    const { flag, attendance } = e.status === 'rejected'
      ? { flag: null, attendance: att.get(key) }
      : reconcile(e, att.get(key), Math.max(0, before));
    const rate = ((emp.salary && emp.salary.ctc) || 0) / 12 / (workingDaysPerMonth || 26) / 8;
    return {
      _id: e._id,
      date: e.date,
      hours: e.hours,
      billable: e.billable,
      status: e.status,
      note: e.note,
      cost: round(e.hours * rate),
      employee: {
        _id: emp._id,
        name: `${(emp.personal || {}).firstName || ''} ${(emp.personal || {}).lastName || ''}`.trim(),
        employeeCode: emp.employeeCode,
        designation: emp.job && emp.job.designationId ? emp.job.designationId.name : null,
      },
      attendance: attendance
        ? { status: attendance.status, hours: attendance.totalHours || 0, checkIn: attendance.checkIn && attendance.checkIn.time, checkOut: attendance.checkOut && attendance.checkOut.time }
        : null,
      flag,
    };
  });

  const live = rows.filter((r) => r.status !== 'rejected');
  return {
    rows,
    totals: {
      hours: round(live.reduce((a, r) => a + r.hours, 0) * 10) / 10,
      billable: round(live.filter((r) => r.billable).reduce((a, r) => a + r.hours, 0) * 10) / 10,
      cost: live.reduce((a, r) => a + r.cost, 0),
      flagged: rows.filter((r) => r.flag).length,
      matchingPending: rows.filter((r) => !r.flag && r.status === 'submitted').length,
    },
  };
}

// ---------------------------------------------------------------- team

/**
 * Who is on the project, how booked they are everywhere else, and who is away
 * in the next two weeks.
 *
 * The list is assigned members plus anyone who has logged time, because an
 * unassigned person whose hours land on the project cost is still on it.
 */
async function teamFor(companyId, project) {
  const assigned = (project.members || []).map(idStr);
  const logged = await Timesheet.distinct('employeeId', { companyId, projectId: project._id, status: { $ne: 'rejected' } });
  const ids = [...new Set([...assigned, ...logged.map(idStr)])];
  if (!ids.length) return { rows: [] };

  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const monthEnd = dayjs().endOf('month').format('YYYY-MM-DD');
  const [emps, hereHours, everywhere, leaves] = await Promise.all([
    Employee.find({ _id: { $in: ids.map(oid) } })
      .select('employeeCode personal.firstName personal.lastName job.designationId')
      .populate('job.designationId', 'name')
      .lean(),
    Timesheet.aggregate([
      { $match: { companyId: oid(companyId), projectId: oid(project._id), status: { $ne: 'rejected' }, date: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: '$employeeId', hours: { $sum: '$hours' } } },
    ]),
    Timesheet.aggregate([
      { $match: { companyId: oid(companyId), employeeId: { $in: ids.map(oid) }, status: { $ne: 'rejected' }, date: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: { e: '$employeeId', p: '$projectId' }, hours: { $sum: '$hours' } } },
    ]),
    Leave.find({
      companyId,
      employeeId: { $in: ids.map(oid) },
      status: 'approved',
      toDate: { $gte: today().format('YYYY-MM-DD') },
      fromDate: { $lte: today().add(LEAVE_LOOKAHEAD_DAYS, 'day').format('YYYY-MM-DD') },
    })
      .select('employeeId fromDate toDate leaveType')
      .lean(),
  ]);

  const here = new Map(hereHours.map((r) => [idStr(r._id), r.hours]));
  const allHours = new Map();
  const projectsPer = new Map();
  for (const r of everywhere) {
    const e = idStr(r._id.e);
    allHours.set(e, (allHours.get(e) || 0) + r.hours);
    if (!projectsPer.has(e)) projectsPer.set(e, new Set());
    projectsPer.get(e).add(idStr(r._id.p));
  }
  const leaveBy = new Map();
  for (const l of leaves) {
    const e = idStr(l.employeeId);
    if (!leaveBy.has(e)) leaveBy.set(e, []);
    leaveBy.get(e).push(l);
  }

  const assignedSet = new Set(assigned);
  return {
    rows: emps.map((e) => {
      const k = idStr(e._id);
      const booked = allHours.get(k) || 0;
      const others = projectsPer.get(k) ? projectsPer.get(k).size - 1 : 0;
      return {
        _id: e._id,
        name: `${(e.personal || {}).firstName || ''} ${(e.personal || {}).lastName || ''}`.trim(),
        employeeCode: e.employeeCode,
        designation: e.job && e.job.designationId ? e.job.designationId.name : null,
        hours: round((here.get(k) || 0) * 10) / 10,
        // Booked hours this month against contracted hours, across every project.
        utilisation: round((booked / STANDARD_MONTH_HOURS) * 100),
        otherProjects: others,
        leave: (leaveBy.get(k) || []).map((l) => ({ from: l.fromDate, to: l.toDate, type: l.leaveType })),
        source: assignedSet.has(k) ? 'assigned' : 'timesheets',
      };
    }).sort((a, b) => b.hours - a.hours),
  };
}

// ---------------------------------------------------------------- coming up

/** Module rows falling due inside the next 30 days, soonest first. */
async function upcomingFor(companyId, projectId) {
  const rows = await ProjectModuleItem.find({
    companyId,
    projectId,
    isDeleted: false,
    dueDate: { $ne: null, $gte: today().toDate(), $lte: today().add(UPCOMING_DAYS, 'day').toDate() },
  })
    .select('title module dueDate status completedAt')
    .sort({ dueDate: 1 })
    .lean();
  return rows
    .filter((r) => !isDone(r))
    .slice(0, 8)
    .map((r) => ({ label: r.title, module: r.module, date: r.dueDate, days: daysUntil(r.dueDate) }));
}

module.exports = {
  enrich,
  healthOf,
  progressOf,
  timesheetsFor,
  teamFor,
  upcomingFor,
  reconcile,
  STALE_APPROVAL_DAYS,
  SCHEDULE_AMBER,
  SCHEDULE_RED,
  BURN_AMBER,
  BURN_RED,
  OVERBOOKED_PCT,
  STANDARD_MONTH_HOURS,
  isDone,
  idStr,
  daysUntil,
};
