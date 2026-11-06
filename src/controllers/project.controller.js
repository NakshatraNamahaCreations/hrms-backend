const mongoose = require('mongoose');
const dayjs = require('dayjs');
const Project = require('../models/Project');
const ProjectTemplate = require('../models/ProjectTemplate');
const Timesheet = require('../models/Timesheet');
const Task = require('../models/Task');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { ROLES, PROJECT_STATUS } = require('../constants');

const POPULATE = [
  { path: 'managerId', select: 'employeeCode personal.firstName personal.lastName' },
  { path: 'members', select: 'employeeCode personal.firstName personal.lastName' },
  { path: 'clientId', select: 'name' },
];

const TIMESHEET_POPULATE = [
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName userId' },
  { path: 'projectId', select: 'name code' },
  { path: 'actionBy', select: 'name' },
];

/**
 * Copies a template's phases onto a new project and spreads them evenly across
 * the contract period, so the project opens with a dated plan the manager can
 * adjust rather than an empty timeline.
 */
const blueprintFields = async (companyId, body) => {
  const out = {
    contractValue: Number(body.contractValue) || 0,
    budget: Number(body.budget) || 0,
    billingType: body.billingType || null,
  };
  if (!body.templateId) return out;
  const template = await ProjectTemplate.findOne({ _id: body.templateId, companyId, isDeleted: false }).lean();
  if (!template) throw new ApiError(400, 'Unknown project template');
  out.templateId = template._id;
  out.billingType = out.billingType || template.billing;

  const start = body.startDate ? dayjs(body.startDate) : dayjs();
  const end = body.endDate ? dayjs(body.endDate) : start.add(90, 'day');
  const span = Math.max(1, end.diff(start, 'day'));
  const n = template.phases.length || 1;
  out.phases = template.phases.map((ph, i) => ({
    name: ph.name,
    gate: ph.gate,
    startDate: start.add(Math.round((i * span) / n), 'day').toDate(),
    endDate: start.add(Math.round(((i + 1) * span) / n) - 1, 'day').toDate(),
  }));
  out.currentPhase = 0;
  return out;
};

// POST /projects (manager+)
const createProject = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { name } = req.body;
  if (!name) throw new ApiError(400, 'name is required');
  if (req.body.status && !PROJECT_STATUS.includes(req.body.status)) {
    throw new ApiError(400, `status must be one of: ${PROJECT_STATUS.join(', ')}`);
  }
  const project = await Project.create({
    companyId,
    name,
    code: req.body.code || null,
    clientId: req.body.clientId || null,
    description: req.body.description || '',
    status: req.body.status || 'active',
    startDate: req.body.startDate ? new Date(req.body.startDate) : null,
    endDate: req.body.endDate ? new Date(req.body.endDate) : null,
    managerId: req.body.managerId || null,
    members: Array.isArray(req.body.members) ? req.body.members : [],
    ...(await blueprintFields(companyId, req.body)),
  });
  return created(res, project, 'Project created');
});

// GET /projects
const listProjects = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId, isDeleted: false };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.managerId) filter.managerId = req.query.managerId;
  const { items, pagination } = await paginate(req.query, Project, filter, {
    searchFields: ['name', 'code'],
    populate: POPULATE,
  });
  return ok(res, items, 'Projects', pagination);
});

// GET /projects/:id — project + taskCount + memberCount
const getProject = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false })
    .populate(POPULATE)
    .lean();
  if (!project) throw new ApiError(404, 'Project not found');
  const taskCount = await Task.countDocuments({ companyId, projectId: project._id, isDeleted: false });
  return ok(res, { ...project, taskCount, memberCount: (project.members || []).length }, 'Project detail');
});

// PUT /projects/:id (manager+)
const updateProject = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!project) throw new ApiError(404, 'Project not found');
  if (req.body.status && !PROJECT_STATUS.includes(req.body.status)) {
    throw new ApiError(400, `status must be one of: ${PROJECT_STATUS.join(', ')}`);
  }
  const updatable = [
    'name', 'code', 'clientId', 'description', 'status', 'startDate', 'endDate', 'managerId', 'members',
    'contractValue', 'budget', 'billingType', 'progressOverride', 'phases', 'currentPhase',
  ];
  for (const key of updatable) {
    if (req.body[key] !== undefined) project[key] = req.body[key];
  }
  await project.save();
  return ok(res, project, 'Project updated');
});

// DELETE /projects/:id (manager+)
const deleteProject = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const project = await Project.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!project) throw new ApiError(404, 'Project not found');
  project.isDeleted = true;
  await project.save();
  return ok(res, null, 'Project deleted');
});

// POST /projects/timesheets — employee logs own hours { projectId, date, hours, note?, billable? }
const submitTimesheet = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const { projectId, date, hours } = req.body;
  if (!projectId) throw new ApiError(400, 'projectId is required');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'date (YYYY-MM-DD) is required');
  const numHours = Number(hours);
  if (!numHours || numHours < 0.5 || numHours > 24) throw new ApiError(400, 'hours must be between 0.5 and 24');

  const project = await Project.findOne({ _id: projectId, companyId, isDeleted: false });
  if (!project) throw new ApiError(404, 'Project not found');

  const timesheet = await Timesheet.create({
    companyId,
    employeeId: req.user.employeeId,
    projectId,
    date,
    hours: numHours,
    note: req.body.note || null,
    billable: Boolean(req.body.billable),
  });
  return created(res, timesheet, 'Timesheet submitted');
});

// GET /projects/timesheets?projectId&employeeId&status&from&to — admins all / employee own
const listTimesheets = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.projectId) filter.projectId = req.query.projectId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.from) filter.date = { $gte: req.query.from };
  if (req.query.to) filter.date = { ...(filter.date || {}), $lte: req.query.to };
  const { items, pagination } = await paginate(req.query, Timesheet, filter, { populate: TIMESHEET_POPULATE });
  return ok(res, items, 'Timesheets', pagination);
});

// PATCH /projects/timesheets/:id/approve|reject (manager+)
const actionTimesheet = (action) =>
  asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const timesheet = await Timesheet.findOne({ _id: req.params.id, companyId }).populate(TIMESHEET_POPULATE);
    if (!timesheet) throw new ApiError(404, 'Timesheet not found');
    if (timesheet.status !== 'submitted') {
      throw new ApiError(400, `Timesheet is '${timesheet.status}', expected 'submitted'`);
    }
    timesheet.status = action;
    timesheet.actionBy = req.user.userId;
    timesheet.actionAt = new Date();
    await timesheet.save();
    return ok(res, timesheet, `Timesheet ${action}`);
  });

// GET /projects/timesheets/summary?projectId&from&to — per-employee hours/billable totals
const timesheetSummary = asyncHandler(async (req, res) => {
  const companyId = new mongoose.Types.ObjectId(String(getCompanyId(req)));
  const match = { companyId };
  if (req.query.projectId) match.projectId = new mongoose.Types.ObjectId(String(req.query.projectId));
  if (req.query.from) match.date = { $gte: req.query.from };
  if (req.query.to) match.date = { ...(match.date || {}), $lte: req.query.to };

  const rows = await Timesheet.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$employeeId',
        totalHours: { $sum: '$hours' },
        billableHours: { $sum: { $cond: ['$billable', '$hours', 0] } },
        approvedHours: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$hours', 0] } },
        entries: { $sum: 1 },
      },
    },
    { $sort: { totalHours: -1 } },
  ]);

  const employees = await Employee.find({ _id: { $in: rows.map((r) => r._id) } })
    .select('employeeCode personal.firstName personal.lastName')
    .lean();
  const byId = new Map(employees.map((e) => [String(e._id), e]));
  const perEmployee = rows.map((row) => {
    const emp = byId.get(String(row._id));
    return {
      employeeId: row._id,
      employeeCode: emp ? emp.employeeCode : null,
      name: emp ? `${emp.personal.firstName} ${emp.personal.lastName || ''}`.trim() : null,
      totalHours: row.totalHours,
      billableHours: row.billableHours,
      approvedHours: row.approvedHours,
      entries: row.entries,
    };
  });
  const totals = perEmployee.reduce(
    (acc, r) => ({
      hours: acc.hours + r.totalHours,
      billableHours: acc.billableHours + r.billableHours,
      entries: acc.entries + r.entries,
    }),
    { hours: 0, billableHours: 0, entries: 0 }
  );
  return ok(res, { perEmployee, totals }, 'Timesheet summary');
});

module.exports = {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  submitTimesheet,
  listTimesheets,
  approveTimesheet: actionTimesheet('approved'),
  rejectTimesheet: actionTimesheet('rejected'),
  timesheetSummary,
};
