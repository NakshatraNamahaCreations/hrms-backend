/**
 * The Projects workspace: saved views, attention signals, the enriched list,
 * a project's detail with its phases and gates, and the generic module rows.
 *
 * The plain CRUD for projects and timesheets stays in project.controller.js;
 * everything here is the derived layer on top of it.
 */
const dayjs = require('dayjs');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectTemplate = require('../models/ProjectTemplate');
const ProjectModuleItem = require('../models/ProjectModuleItem');
const Task = require('../models/Task');
const Timesheet = require('../models/Timesheet');
const Company = require('../models/Company');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const insights = require('../services/projectInsights.service');
const { BLUEPRINTS, toTemplate, BILLING_LABELS } = require('../constants/projectBlueprints');
const { PROJECT_MODULES } = require('../constants');

const POPULATE = [
  { path: 'managerId', select: 'employeeCode personal.firstName personal.lastName' },
  { path: 'clientId', select: 'name' },
  { path: 'templateId', select: 'key name code vocab modules billing' },
];

const idStr = insights.idStr;

/** Working days per month drives the hourly cost rate derived from CTC. */
const workingDays = async (companyId) => {
  const c = await Company.findById(companyId).select('settings.payroll.workingDaysPerMonth').lean();
  return Number(c && c.settings && c.settings.payroll && c.settings.payroll.workingDaysPerMonth) || 26;
};

// ---------------------------------------------------------------- templates

/**
 * A company's blueprints, seeded from the shipped set on first use. Seeding is
 * idempotent on `key`, so adding a blueprint in a later release reaches
 * existing companies without touching the ones they have edited.
 */
const ensureTemplates = async (companyId) => {
  const existing = await ProjectTemplate.find({ companyId }).lean();
  const have = new Set(existing.map((t) => t.key));
  const missing = BLUEPRINTS.filter((b) => !have.has(b.key));
  if (missing.length) {
    await ProjectTemplate.insertMany(missing.map((b) => ({ companyId, ...toTemplate(b) })));
    return ProjectTemplate.find({ companyId, isDeleted: false }).lean();
  }
  return existing.filter((t) => !t.isDeleted);
};

// GET /projects/templates
const listTemplates = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const templates = await ensureTemplates(companyId);
  return ok(
    res,
    templates.map((t) => ({ ...t, billingLabel: BILLING_LABELS[t.billing] || t.billing })),
    'Project templates'
  );
});

// ---------------------------------------------------------------- views and signals

const VIEW_FILTERS = {
  all: (p) => p.status !== 'completed',
  green: (p) => p.status === 'active' && p.health.level === 'green',
  amber: (p) => p.status === 'active' && p.health.level === 'amber',
  red: (p) => p.status === 'active' && p.health.level === 'red',
  hold: (p) => p.status === 'on_hold',
  completed: (p) => p.status === 'completed',
};

const SIGNAL_FILTERS = {
  // An approval the client has held past the point where it stops being normal.
  staleApprovals: (p) => (p.waiting[0] || {}).days >= insights.STALE_APPROVAL_DAYS,
  // Budget running ahead of the work it is buying.
  overBurn: (p) => p.status === 'active' && p.budget > 0 && p.burnPct - p.progress > insights.BURN_AMBER,
  // Logged time that the punch record does not support.
  tsMismatch: (p) => p.tsMismatch > 0,
  // A licence, statutory filing or service visit landing inside 30 days.
  expiring: (p) => Object.values(p.moduleStats || {}).some((m) => m.alert > 0) || Boolean(p.upcomingSoon),
};

/** Every live project, enriched. The views and signals are slices of this. */
const loadEnriched = async (req, companyId, extraFilter = {}) => {
  const filter = { companyId, isDeleted: false, ...extraFilter };
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.managerId) filter.managerId = req.query.managerId;
  if (req.query.templateId) filter.templateId = req.query.templateId;
  if (req.query.search) {
    const rx = { $regex: String(req.query.search).slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ name: rx }, { code: rx }];
  }
  const rows = await Project.find(filter).populate(POPULATE).lean();
  const wd = await workingDays(companyId);
  return insights.enrich(companyId, rows, { workingDaysPerMonth: wd });
};

// GET /projects/summary
const projectSummary = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const all = await loadEnriched(req, companyId);
  const live = all.filter((p) => p.status !== 'completed');

  // Utilisation is a people number, not a project one, so it is counted over
  // everyone who logged time this month rather than per project.
  const overbooked = await overbookedCount(companyId);

  return ok(
    res,
    {
      views: Object.fromEntries(Object.entries(VIEW_FILTERS).map(([k, f]) => [k, all.filter(f).length])),
      signals: {
        staleApprovals: live.filter(SIGNAL_FILTERS.staleApprovals).length,
        overBurn: live.filter(SIGNAL_FILTERS.overBurn).length,
        tsMismatch: live.reduce((a, p) => a + p.tsMismatch, 0),
        expiring: live.filter(SIGNAL_FILTERS.expiring).length,
        overbooked,
      },
      thresholds: {
        staleApprovalDays: insights.STALE_APPROVAL_DAYS,
        scheduleAmber: insights.SCHEDULE_AMBER,
        scheduleRed: insights.SCHEDULE_RED,
        burnAmber: insights.BURN_AMBER,
        burnRed: insights.BURN_RED,
        overbookedPct: insights.OVERBOOKED_PCT,
      },
    },
    'Project summary'
  );
});

/** People booked above the overbooked threshold this month, across all projects. */
const overbookedPeople = async (companyId) => {
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const monthEnd = dayjs().endOf('month').format('YYYY-MM-DD');
  const rows = await Timesheet.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)), status: { $ne: 'rejected' }, date: { $gte: monthStart, $lte: monthEnd } } },
    { $group: { _id: { e: '$employeeId', p: '$projectId' }, hours: { $sum: '$hours' } } },
    { $group: { _id: '$_id.e', hours: { $sum: '$hours' }, projects: { $sum: 1 } } },
  ]);
  const over = rows
    .map((r) => ({ ...r, util: Math.round((r.hours / insights.STANDARD_MONTH_HOURS) * 100) }))
    .filter((r) => r.util > insights.OVERBOOKED_PCT);
  if (!over.length) return [];
  const emps = await Employee.find({ _id: { $in: over.map((r) => r._id) } })
    .select('employeeCode personal.firstName personal.lastName job.designationId')
    .populate('job.designationId', 'name')
    .lean();
  const byId = new Map(emps.map((e) => [idStr(e._id), e]));
  return over
    .map((r) => {
      const e = byId.get(idStr(r._id));
      if (!e) return null;
      return {
        _id: e._id,
        name: `${(e.personal || {}).firstName || ''} ${(e.personal || {}).lastName || ''}`.trim(),
        designation: e.job && e.job.designationId ? e.job.designationId.name : null,
        hours: Math.round(r.hours * 10) / 10,
        utilisation: r.util,
        projects: r.projects,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.utilisation - a.utilisation);
};
const overbookedCount = async (companyId) => (await overbookedPeople(companyId)).length;

// GET /projects/overbooked
const listOverbooked = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  return ok(res, await overbookedPeople(companyId), 'People booked above capacity');
});

// GET /projects/workspace — the enriched, filtered, sorted list
const SORTS = {
  name: (p) => String(p.name || '').toLowerCase(),
  phase: (p) => p.currentPhase || 0,
  // Worst health first, then furthest behind schedule within a level.
  health: (p) => ({ red: 3, amber: 2, green: 1, grey: 0 }[p.health.level] || 0) * 1000 - p.health.gap,
  progress: (p) => p.progress - p.timePct,
  budget: (p) => p.burnPct - p.progress,
  margin: (p) => p.margin,
  next: (p) => (p.next ? p.next.days : 99999),
};

const listWorkspace = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  let rows = await loadEnriched(req, companyId);

  const view = req.query.view || 'all';
  rows = rows.filter(VIEW_FILTERS[view] || VIEW_FILTERS.all);
  if (req.query.signal && SIGNAL_FILTERS[req.query.signal]) rows = rows.filter(SIGNAL_FILTERS[req.query.signal]);

  const sortKey = SORTS[req.query.sortBy] ? req.query.sortBy : 'health';
  const dir = req.query.sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = SORTS[sortKey](a);
    const y = SORTS[sortKey](b);
    return x > y ? dir : x < y ? -dir : 0;
  });

  return ok(res, rows, `${rows.length} projects`);
});

// ---------------------------------------------------------------- detail

// GET /projects/:id/workspace
const getWorkspace = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const raw = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false }).populate(POPULATE).lean();
  if (!raw) throw new ApiError(404, 'Project not found');
  const wd = await workingDays(companyId);
  const [p] = await insights.enrich(companyId, [raw], { workingDaysPerMonth: wd });
  const upcoming = await insights.upcomingFor(companyId, raw._id);
  const tsCount = await Timesheet.countDocuments({ companyId, projectId: raw._id });
  return ok(
    res,
    {
      ...p,
      billingLabel: BILLING_LABELS[p.billingType] || null,
      upcoming,
      counts: { items: p.taskStats.total, timesheets: tsCount, tsFlags: p.tsMismatch, modules: p.moduleStats },
    },
    'Project workspace'
  );
});

// GET /projects/:id/items — the project's tasks
const listItems = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false }).select('phases').lean();
  if (!project) throw new ApiError(404, 'Project not found');

  const tasks = await Task.find({ companyId, projectId: req.params.id, isDeleted: false })
    .populate('assignedTo', 'employeeCode personal.firstName personal.lastName')
    .sort({ dueDate: 1 })
    .lean();

  // Estimated and logged hours sit beside each task so over-run is visible
  // without opening it.
  const logged = await Timesheet.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)), projectId: new mongoose.Types.ObjectId(String(req.params.id)), status: { $ne: 'rejected' } } },
    { $group: { _id: '$taskId', hours: { $sum: '$hours' } } },
  ]);
  const byTask = new Map(logged.map((r) => [idStr(r._id), r.hours]));

  return ok(
    res,
    tasks.map((t) => {
      const emp = t.assignedTo || {};
      const overdue = t.status !== 'completed' && t.dueDate && insights.daysUntil(t.dueDate) < 0;
      return {
        _id: t._id,
        title: t.title,
        phase: typeof t.phaseIndex === 'number' ? (project.phases[t.phaseIndex] || {}).name : null,
        assignee: {
          _id: emp._id,
          name: `${(emp.personal || {}).firstName || ''} ${(emp.personal || {}).lastName || ''}`.trim(),
          employeeCode: emp.employeeCode,
        },
        dueDate: t.dueDate,
        priority: t.priority,
        status: overdue ? 'overdue' : t.status,
        estimateHours: t.estimateHours || null,
        loggedHours: Math.round((byTask.get(idStr(t._id)) || 0) * 10) / 10,
      };
    }),
    'Project items'
  );
});

// GET /projects/:id/timesheets-detail
const listProjectTimesheets = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const exists = await Project.exists({ _id: req.params.id, companyId, isDeleted: false });
  if (!exists) throw new ApiError(404, 'Project not found');
  const wd = await workingDays(companyId);
  return ok(res, await insights.timesheetsFor(companyId, req.params.id, wd), 'Project timesheets');
});

// GET /projects/:id/team
const getTeam = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false }).select('members').lean();
  if (!project) throw new ApiError(404, 'Project not found');
  return ok(res, await insights.teamFor(companyId, project), 'Project team');
});

// ---------------------------------------------------------------- modules

// GET /projects/:id/modules/:module
const listModule = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { module } = req.params;
  if (!PROJECT_MODULES.includes(module)) throw new ApiError(400, `Unknown module '${module}'`);
  const exists = await Project.exists({ _id: req.params.id, companyId, isDeleted: false });
  if (!exists) throw new ApiError(404, 'Project not found');

  const rows = await ProjectModuleItem.find({ companyId, projectId: req.params.id, module, isDeleted: false })
    .populate('ownerId', 'employeeCode personal.firstName personal.lastName')
    .sort({ dueDate: 1, createdAt: -1 })
    .lean();

  return ok(
    res,
    {
      module,
      rows: rows.map((r) => {
        const o = r.ownerId || null;
        return {
          _id: r._id,
          title: r.title,
          status: r.status,
          dueDate: r.dueDate,
          sentOn: r.sentOn,
          decidedOn: r.decidedOn,
          completedAt: r.completedAt,
          amount: r.amount,
          daysImpact: r.daysImpact,
          // Days the client has held this, or null when it is not with them.
          waitingDays: r.sentOn && !r.decidedOn ? Math.max(0, -insights.daysUntil(r.sentOn)) : null,
          overdue: !insights.isDone(r) && r.dueDate ? insights.daysUntil(r.dueDate) < 0 : false,
          owner: o ? { _id: o._id, name: `${(o.personal || {}).firstName || ''} ${(o.personal || {}).lastName || ''}`.trim() } : null,
          ...r.data,
        };
      }),
    },
    'Module rows'
  );
});

// POST /projects/:id/modules/:module
const createModuleItem = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { module } = req.params;
  if (!PROJECT_MODULES.includes(module)) throw new ApiError(400, `Unknown module '${module}'`);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false }).select('_id').lean();
  if (!project) throw new ApiError(404, 'Project not found');
  if (!req.body.title) throw new ApiError(400, 'title is required');

  const { title, status, dueDate, amount, daysImpact, ownerId, sendToClient, ...rest } = req.body;
  const item = await ProjectModuleItem.create({
    companyId,
    projectId: project._id,
    module,
    title,
    status: status || (module === 'approvals' && sendToClient ? 'waiting_on_client' : 'open'),
    dueDate: dueDate ? new Date(dueDate) : null,
    // An approval that goes out to the client starts its clock now.
    sentOn: module === 'approvals' && sendToClient ? new Date() : null,
    amount: Number(amount) || 0,
    daysImpact: Number(daysImpact) || 0,
    ownerId: ownerId || null,
    data: rest,
  });
  return created(res, item, 'Added');
});

// PATCH /projects/:id/modules/:module/:itemId
const updateModuleItem = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const item = await ProjectModuleItem.findOne({ _id: req.params.itemId, companyId, projectId: req.params.id, isDeleted: false });
  if (!item) throw new ApiError(404, 'Item not found');

  const { title, status, dueDate, amount, daysImpact, ownerId, decision, ...rest } = req.body;
  if (title !== undefined) item.title = title;
  if (dueDate !== undefined) item.dueDate = dueDate ? new Date(dueDate) : null;
  if (amount !== undefined) item.amount = Number(amount) || 0;
  if (daysImpact !== undefined) item.daysImpact = Number(daysImpact) || 0;
  if (ownerId !== undefined) item.ownerId = ownerId || null;
  // Recording a client decision stops the wait clock, which is what schedule
  // health reads — so it must happen in the same write as the status change.
  if (decision === 'approved' || decision === 'rejected') {
    item.status = decision;
    item.decidedOn = new Date();
  } else if (status !== undefined) {
    item.status = status;
  }
  if (insights.isDone(item) && !item.completedAt) item.completedAt = new Date();
  if (Object.keys(rest).length) item.data = { ...item.data, ...rest };
  await item.save();
  return ok(res, item, 'Updated');
});

// DELETE /projects/:id/modules/:module/:itemId
const deleteModuleItem = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const item = await ProjectModuleItem.findOneAndUpdate(
    { _id: req.params.itemId, companyId, projectId: req.params.id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!item) throw new ApiError(404, 'Item not found');
  return ok(res, { _id: item._id }, 'Deleted');
});

// ---------------------------------------------------------------- actions

// PATCH /projects/:id/hold
const holdProject = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!project) throw new ApiError(404, 'Project not found');
  if (project.status === 'completed') throw new ApiError(400, 'A completed project cannot be put on hold');
  project.status = 'on_hold';
  project.holdReason = req.body.reason || null;
  project.heldAt = new Date();
  await project.save();
  return ok(res, project, 'Project on hold');
});

// PATCH /projects/:id/resume
const resumeProject = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!project) throw new ApiError(404, 'Project not found');
  if (project.status !== 'on_hold') throw new ApiError(400, 'This project is not on hold');
  // Bank the paused days so the schedule forecast does not blame the team.
  if (project.heldAt) project.holdDays += Math.max(0, dayjs().startOf('day').diff(dayjs(project.heldAt).startOf('day'), 'day'));
  project.status = 'active';
  project.holdReason = null;
  project.heldAt = null;
  await project.save();
  return ok(res, project, 'Project resumed');
});

// PATCH /projects/:id/phase — advance, or sign off a gate
const advancePhase = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!project) throw new ApiError(404, 'Project not found');
  const idx = Number(req.body.phaseIndex);
  const phase = project.phases[idx];
  if (!phase) throw new ApiError(400, 'No such phase');

  if (req.body.signOff) {
    if (!phase.gate) throw new ApiError(400, 'This phase does not need a client sign-off');
    phase.signedOffAt = new Date();
    phase.signedOffBy = req.body.signedOffBy || null;
  }
  if (req.body.advance) {
    // A gate cannot be passed until the client has actually signed it.
    if (phase.gate && !phase.signedOffAt) throw new ApiError(400, `“${phase.name}” needs the client's sign-off before the project can move past it`);
    phase.completedAt = phase.completedAt || new Date();
    project.currentPhase = Math.min(idx + 1, project.phases.length - 1);
  }
  await project.save();
  return ok(res, project, req.body.signOff ? 'Sign-off recorded' : 'Phase advanced');
});

// POST /projects/:id/timesheets/approve-matching
const approveMatching = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const exists = await Project.exists({ _id: req.params.id, companyId, isDeleted: false });
  if (!exists) throw new ApiError(404, 'Project not found');
  const wd = await workingDays(companyId);
  const { rows } = await insights.timesheetsFor(companyId, req.params.id, wd);
  // Only entries the punch record supports. Flagged ones keep needing a human.
  const ids = rows.filter((r) => !r.flag && r.status === 'submitted').map((r) => r._id);
  if (!ids.length) return ok(res, { approved: 0 }, 'Nothing to approve');
  await Timesheet.updateMany(
    { _id: { $in: ids }, companyId },
    { status: 'approved', actionBy: req.user.id || req.user._id, actionAt: new Date() }
  );
  return ok(res, { approved: ids.length }, `Approved ${ids.length}`);
});

module.exports = {
  listTemplates,
  ensureTemplates,
  projectSummary,
  listWorkspace,
  listOverbooked,
  getWorkspace,
  listItems,
  listProjectTimesheets,
  getTeam,
  listModule,
  createModuleItem,
  updateModuleItem,
  deleteModuleItem,
  holdProject,
  resumeProject,
  advancePhase,
  approveMatching,
};
