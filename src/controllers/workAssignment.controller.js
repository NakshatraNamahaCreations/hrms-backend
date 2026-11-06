const dayjs = require('dayjs');
const FieldWorkAssignment = require('../models/FieldWorkAssignment');
const Employee = require('../models/Employee');
const Client = require('../models/Client');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isManagerial } = require('../utils/scope');
const { toPublicUrl } = require('../middleware/upload');
const { notify } = require('../services/notification.service');
const { haversineMeters } = require('../utils/geo');
const Company = require('../models/Company');
const { computeTeamCosting } = require('../utils/costing');
const { ROLES, WORK_ASSIGNMENT_TRANSITIONS, WORK_ASSIGNMENT_STATUS } = require('../constants');

// Simple status buckets for the Jobs list filter (Pending / Ongoing / Hold /
// Completed / Cancelled) → the underlying field-flow statuses they cover.
const STATUS_GROUPS = {
  pending: ['assigned', 'rejected', 'rescheduled'],
  ongoing: ['accepted', 'on_the_way', 'reached', 'checked_in', 'in_progress'],
  hold: ['on_hold'],
  completed: ['completed', 'checked_out'],
  cancelled: ['cancelled'],
};

// Job value + profit are visible to the company owner (company_admin) only.
const canSeeProfit = (role) => role === ROLES.COMPANY_ADMIN || role === ROLES.SUPER_ADMIN;
const PROFIT_FIELDS = ['jobValue', 'costing', 'daysWorkedOverride'];
// Per-member money fields hidden from non-admins (role/status/days/check-in stay visible).
const ASSIGNEE_MONEY_FIELDS = ['dailyCost', 'cost', 'profit', 'daysOverride'];
function redactProfit(doc, role) {
  if (!doc || canSeeProfit(role)) return doc;
  if (Array.isArray(doc)) return doc.map((d) => redactProfit(d, role));
  const clone = { ...doc };
  for (const f of PROFIT_FIELDS) delete clone[f];
  if (Array.isArray(clone.assignees)) {
    clone.assignees = clone.assignees.map((a) => {
      const m = a && a.toObject ? a.toObject() : { ...a };
      for (const f of ASSIGNEE_MONEY_FIELDS) delete m[f];
      return m;
    });
  }
  return clone;
}

// Legacy jobs may have an empty assignees array — synthesize the lone member from
// the top-level employeeId so costing/my/profitability still work for them.
function effectiveAssignees(assignment) {
  if (Array.isArray(assignment.assignees) && assignment.assignees.length) return assignment.assignees;
  if (assignment.employeeId) {
    const empId = assignment.employeeId._id || assignment.employeeId;
    return [{ employeeId: empId, role: null, employeeType: null, status: 'assigned', workDays: [], daysOverride: null }];
  }
  return [];
}

// Load salary for every assignee employee in ONE query → { employeeIdString: empDoc }.
async function loadEmployeesById(assignees) {
  const ids = (assignees || [])
    .map((a) => String((a.employeeId && (a.employeeId._id || a.employeeId)) || ''))
    .filter(Boolean);
  if (!ids.length) return {};
  const emps = await Employee.find({ _id: { $in: ids } }).select('salary employeeCode personal job').lean();
  const map = {};
  for (const e of emps) map[String(e._id)] = e;
  return map;
}

const empName = (e) => (e && e.personal ? `${e.personal.firstName} ${e.personal.lastName || ''}`.trim() : '—');
const POPULATE = [
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName personal.phone userId' },
  { path: 'assignees.employeeId', select: 'employeeCode personal.firstName personal.lastName personal.phone' },
  { path: 'checklist.assigneeId', select: 'employeeCode personal.firstName personal.lastName' },
  { path: 'clientId', select: 'name contactPerson phone address location geoFenceRadiusMeters' },
  { path: 'assignedBy', select: 'name' },
];

// Accept checklist as ["item", ...] or [{ label|text|title, completed? }, ...]
const normalizeChecklist = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) =>
      typeof item === 'string'
        ? { label: item.trim(), completed: false, assigneeId: null }
        : {
            label: String(item.label || item.item || item.text || item.title || '').trim(),
            completed: !!(item.completed || item.done),
            assigneeId: item.assigneeId || null,
          }
    )
    .filter((item) => item.label);
};

// Multipart submissions JSON-stringify object fields — restore them.
const parseAssignmentBody = (body) => {
  for (const key of ['clientLocation', 'checklist', 'assignees']) {
    if (typeof body[key] === 'string' && /^[[{]/.test(body[key].trim())) {
      try {
        body[key] = JSON.parse(body[key]);
      } catch (e) {
        /* leave as-is */
      }
    }
  }
  return body;
};

// Explicit job location from the form (Google search) — overrides the client's pin.
// Client is optional (internal/office jobs have no client).
const resolveJobLocation = (bodyLocation, client) => {
  const c = client || {};
  const loc = bodyLocation || {};
  if (loc.latitude != null && loc.longitude != null) {
    const latitude = Number(loc.latitude);
    const longitude = Number(loc.longitude);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new ApiError(400, 'Invalid clientLocation latitude/longitude');
    }
    return { latitude, longitude, address: loc.address || c.address || null };
  }
  if (c.location && c.location.latitude != null) {
    return {
      latitude: c.location.latitude,
      longitude: c.location.longitude,
      address: c.address || null,
    };
  }
  return { latitude: null, longitude: null, address: c.address || null };
};

// Normalize the team from the body: prefer `assignees:[{employeeId, role}]`,
// fall back to the legacy single `employeeId`. De-dupes by employeeId.
const normalizeTeam = (body) => {
  const raw = Array.isArray(body.assignees) && body.assignees.length
    ? body.assignees
    : (body.employeeId ? [{ employeeId: body.employeeId, role: body.role || null }] : []);
  const seen = new Set();
  const team = [];
  for (const a of raw) {
    const id = String((a && (a.employeeId && (a.employeeId._id || a.employeeId))) || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    team.push({ employeeId: id, role: (a.role || '').toString().trim() || null });
  }
  return team;
};

// POST /work-assignments (manager+)
// Accepts a TEAM: assignees:[{ employeeId, role }] (new) OR a legacy single employeeId.
// Any office/field employee can be assigned. clientId is optional (internal jobs).
const createAssignment = asyncHandler(async (req, res) => {
  parseAssignmentBody(req.body);
  const companyId = getCompanyId(req);
  const { clientId, title, date } = req.body;
  const team = normalizeTeam(req.body);
  if (!team.length || !title || !date) {
    throw new ApiError(400, 'At least one assignee (employeeId/assignees), title and date are required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'date must be YYYY-MM-DD');

  // Validate the whole team (exists, active, same company) in one query.
  const employees = await Employee.find({
    _id: { $in: team.map((t) => t.employeeId) }, companyId, isDeleted: false, status: 'active',
  });
  if (employees.length !== team.length) {
    throw new ApiError(404, 'One or more assignees not found or inactive');
  }
  const empById = new Map(employees.map((e) => [String(e._id), e]));

  // Client is optional; only validate/lookup when provided.
  let client = null;
  if (clientId) {
    client = await Client.findOne({ _id: clientId, companyId, isDeleted: false });
    if (!client) throw new ApiError(404, 'Client not found');
  }

  // Build the assignees array (snapshot employeeType from each employee).
  const assignees = team.map((t) => {
    const emp = empById.get(String(t.employeeId));
    return {
      employeeId: emp._id,
      role: t.role,
      employeeType: emp.job && emp.job.employeeType ? emp.job.employeeType : null,
      status: 'assigned',
      workDays: [],
    };
  });

  const assignment = await FieldWorkAssignment.create({
    companyId,
    employeeId: assignees[0].employeeId, // primary member — backward compat
    clientId: client ? client._id : null,
    title,
    description: req.body.description || '',
    instructions: req.body.instructions || null,
    date,
    startTime: req.body.startTime || null,
    endTime: req.body.endTime || null,
    expectedDurationMinutes: req.body.expectedDurationMinutes || null,
    priority: req.body.priority || 'medium',
    checklist: normalizeChecklist(req.body.checklist),
    assignees,
    assignedBy: req.user.userId,
    // per-assignment location (Google search in the form) > client pin > address-only (no fence)
    clientLocation: resolveJobLocation(req.body.clientLocation, client),
    attachments: (req.files || []).map((f) => toPublicUrl(f.path)),
    statusHistory: [{ status: 'assigned', by: req.user.userId }],
    jobValue: canSeeProfit(req.user.role) ? Math.max(0, Number(req.body.jobValue) || 0) : 0,
  });

  // Notify each assignee's user (push).
  const where = client ? ` at ${client.name}` : '';
  await Promise.all(employees.filter((e) => e.userId).map((e) => notify({
    companyId,
    userId: e.userId,
    title: 'New work assignment',
    message: `You have been assigned "${title}"${where} on ${date}.`,
    type: 'work_assignment',
    meta: { assignmentId: assignment._id },
    channels: ['push'],
  })));

  return created(res, redactProfit(assignment.toObject(), req.user.role), 'Work assignment created');
});

// GET /work-assignments
const listAssignments = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId, isDeleted: false };
  if (req.user.role === ROLES.FIELD_EMPLOYEE || req.user.role === ROLES.EMPLOYEE) {
    // Non-managers only see jobs they belong to (primary OR team member).
    filter.$or = [{ employeeId: req.user.employeeId }, { 'assignees.employeeId': req.user.employeeId }];
  } else if (req.query.employeeId) {
    filter.$or = [{ employeeId: req.query.employeeId }, { 'assignees.employeeId': req.query.employeeId }];
  }
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.status) {
    filter.status = STATUS_GROUPS[req.query.status] ? { $in: STATUS_GROUPS[req.query.status] } : req.query.status;
  }
  if (req.query.priority) filter.priority = req.query.priority;
  if (req.query.date) filter.date = req.query.date;
  else if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = req.query.from;
    if (req.query.to) filter.date.$lte = req.query.to;
  }
  const { items, pagination } = await paginate(req.query, FieldWorkAssignment, filter, {
    searchFields: ['title', 'description', 'status'],
    sortable: ['date', 'title', 'status', 'priority', 'createdAt', 'updatedAt'],
    populate: POPULATE,
    sort: { date: -1, createdAt: -1 },
  });
  return ok(res, redactProfit(items, req.user.role), 'Work assignments', pagination);
});

// GET /work-assignments/my — field employee groupings
const myAssignments = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const me = req.user.employeeId;
  const todayStr = dayjs().format('YYYY-MM-DD');
  // I see a job if I'm the legacy primary employeeId OR a team member.
  const base = {
    companyId,
    isDeleted: false,
    $or: [{ employeeId: me }, { 'assignees.employeeId': me }],
  };

  // Multi-day jobs: "today" = every ONGOING job (started on or before today,
  // not finished) — a 15-day project stays here until it is completed.
  const [todayList, upcoming, completed] = await Promise.all([
    FieldWorkAssignment.find({
      ...base,
      date: { $lte: todayStr },
      status: { $nin: ['completed', 'checked_out', 'cancelled', 'rejected'] },
    }).populate(POPULATE).sort({ startTime: 1, date: 1 }).lean(),
    FieldWorkAssignment.find({
      ...base,
      date: { $gt: todayStr },
      status: { $in: ['assigned', 'accepted', 'rescheduled'] },
    }).populate(POPULATE).sort({ date: 1 }).limit(50).lean(),
    FieldWorkAssignment.find({ ...base, status: { $in: ['completed', 'checked_out'] } })
      .populate(POPULATE).sort({ date: -1 }).limit(50).lean(),
  ]);

  const role = req.user.role;
  return ok(res, {
    today: redactProfit(todayList, role),
    upcoming: redactProfit(upcoming, role),
    completed: redactProfit(completed, role),
  }, 'My assignments');
});

// GET /work-assignments/:id
const getAssignment = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId, isDeleted: false };
  // Non-managers may only see jobs they belong to (primary OR team member).
  if (req.user.role === ROLES.FIELD_EMPLOYEE || req.user.role === ROLES.EMPLOYEE) {
    filter.$or = [{ employeeId: req.user.employeeId }, { 'assignees.employeeId': req.user.employeeId }];
  }
  const assignment = await FieldWorkAssignment.findOne(filter).populate(POPULATE).lean();
  if (!assignment) throw new ApiError(404, 'Work assignment not found');

  // company_admin/super_admin: compute LIVE team costing and attach per-member money.
  if (canSeeProfit(req.user.role)) {
    const assignees = effectiveAssignees(assignment);
    const [company, employeesById] = await Promise.all([
      Company.findById(companyId).select('settings').lean(),
      loadEmployeesById(assignees),
    ]);
    const team = computeTeamCosting({ jobValue: assignment.jobValue, assignees, employeesById, company });
    return ok(res, { ...assignment, assignees: team.members, costing: team }, 'Work assignment detail');
  }
  return ok(res, redactProfit(assignment, req.user.role), 'Work assignment detail');
});

// PUT /work-assignments/:id (manager+)
const updateAssignment = asyncHandler(async (req, res) => {
  parseAssignmentBody(req.body);
  const companyId = getCompanyId(req);
  const assignment = await FieldWorkAssignment.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!assignment) throw new ApiError(404, 'Work assignment not found');
  if (['completed', 'checked_out', 'cancelled'].includes(assignment.status)) {
    throw new ApiError(400, `Cannot edit an assignment in '${assignment.status}' state`);
  }
  const updatable = ['title', 'description', 'instructions', 'date', 'startTime', 'endTime', 'priority', 'expectedDurationMinutes'];
  for (const key of updatable) {
    if (req.body[key] !== undefined) assignment[key] = req.body[key];
  }
  if (req.body.checklist !== undefined) assignment.checklist = normalizeChecklist(req.body.checklist);
  // update the job location (Google search in the form)
  if (req.body.clientLocation && req.body.clientLocation.latitude != null) {
    assignment.clientLocation = resolveJobLocation(req.body.clientLocation, {
      address: (assignment.clientLocation && assignment.clientLocation.address) || null,
      location: null,
    });
  }
  // reassign the primary member to another employee (office or field)
  if (req.body.employeeId && String(req.body.employeeId) !== String(assignment.employeeId)) {
    const employee = await Employee.findOne({
      _id: req.body.employeeId, companyId, isDeleted: false, status: 'active',
    });
    if (!employee) throw new ApiError(404, 'Employee not found or inactive');
    assignment.employeeId = employee._id;
    // Keep assignees[0] (primary) in sync with the reassigned employeeId.
    const empType = employee.job && employee.job.employeeType ? employee.job.employeeType : null;
    if (Array.isArray(assignment.assignees) && assignment.assignees.length) {
      assignment.assignees[0].employeeId = employee._id;
      assignment.assignees[0].employeeType = empType;
      assignment.assignees[0].status = 'assigned';
      assignment.assignees[0].workDays = [];
      assignment.assignees[0].checkInAt = null;
      assignment.assignees[0].checkOutAt = null;
    } else {
      assignment.assignees.push({ employeeId: employee._id, employeeType: empType, status: 'assigned', workDays: [] });
    }
    assignment.status = 'assigned';
    assignment.statusHistory.push({ status: 'assigned', by: req.user.userId, note: 'Reassigned' });
    if (employee.userId) {
      await notify({
        companyId,
        userId: employee.userId,
        title: 'New work assignment',
        message: `You have been assigned "${assignment.title}" on ${assignment.date}.`,
        type: 'work_assignment',
        meta: { assignmentId: assignment._id },
        channels: ['push'],
      });
    }
  }
  if (req.body.clientId && String(req.body.clientId) !== String(assignment.clientId)) {
    const client = await Client.findOne({ _id: req.body.clientId, companyId, isDeleted: false });
    if (!client) throw new ApiError(404, 'Client not found');
    assignment.clientId = client._id;
    assignment.clientLocation = {
      latitude: client.location.latitude,
      longitude: client.location.longitude,
      address: client.address || null,
    };
  }
  await assignment.save();
  return ok(res, assignment, 'Work assignment updated');
});

// Find the calling employee's assignee subdoc, synthesizing one from the legacy
// employeeId if assignees is empty but the caller is the primary member.
function findMyAssignee(assignment, employeeId) {
  const me = String(employeeId);
  if (Array.isArray(assignment.assignees) && assignment.assignees.length) {
    return assignment.assignees.find((a) => String(a.employeeId) === me) || null;
  }
  if (assignment.employeeId && String(assignment.employeeId) === me) {
    // Legacy single-employee job: materialize a member so check-ins are tracked.
    assignment.assignees.push({ employeeId: assignment.employeeId, status: 'assigned', workDays: [] });
    return assignment.assignees[0];
  }
  return null;
}

// Recompute team costing from current state and PERSIST it onto the doc
// (per-assignee dailyCost/daysWorked/cost/profit + job-level `costing`).
async function persistTeamCosting(assignment, companyId) {
  const assignees = effectiveAssignees(assignment);
  const [company, employeesById] = await Promise.all([
    Company.findById(companyId).select('settings').lean(),
    loadEmployeesById(assignees),
  ]);
  const team = computeTeamCosting({ jobValue: assignment.jobValue, assignees, employeesById, company });
  // Map costed members back onto the real subdocs by employeeId.
  for (const m of team.members) {
    const key = String(m.employeeId && (m.employeeId._id || m.employeeId));
    const sub = (assignment.assignees || []).find((a) => String(a.employeeId) === key);
    if (sub) {
      sub.dailyCost = m.dailyCost;
      sub.daysWorked = m.daysWorked;
      sub.cost = m.cost;
      sub.profit = m.profit;
    }
  }
  assignment.costing = {
    dailyCost: 0,
    daysWorked: team.daysTotal,
    laborCost: team.totalCost,
    profit: team.profit,
    margin: team.margin,
    computedAt: new Date(),
  };
  return team;
}

// POST /work-assignments/:id/checkin  { latitude?, longitude? }
// The calling employee checks in to the job (per-job timesheet). Distinct workDays
// drive the member's day-wise cost. Location is recorded but never hard-blocks.
const checkInJob = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const assignment = await FieldWorkAssignment.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!assignment) throw new ApiError(404, 'Work assignment not found');

  const me = findMyAssignee(assignment, req.user.employeeId);
  if (!me) throw new ApiError(403, 'You are not assigned to this job');

  const today = dayjs().format('YYYY-MM-DD');
  me.checkInAt = new Date();
  me.checkOutAt = null;
  me.status = 'in_progress';
  if (!Array.isArray(me.workDays)) me.workDays = [];
  if (!me.workDays.includes(today)) me.workDays.push(today);

  const lat = req.body.latitude != null ? Number(req.body.latitude) : null;
  const lng = req.body.longitude != null ? Number(req.body.longitude) : null;
  if (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    me.lastLocation = { latitude: lat, longitude: lng };
    // Field members: record distance to the job pin (lenient — never blocks check-in).
    if (me.employeeType === 'field_employee' && assignment.clientLocation
        && assignment.clientLocation.latitude != null) {
      me.distanceMeters = haversineMeters(
        lat, lng, assignment.clientLocation.latitude, assignment.clientLocation.longitude
      );
    }
  }

  // Bump the JOB-level status to 'in_progress' when the transition is allowed.
  if (['assigned', 'accepted'].includes(assignment.status)) {
    assignment.status = 'in_progress';
    assignment.statusHistory.push({ status: 'in_progress', by: req.user.userId, note: 'Member check-in' });
  }
  await assignment.save();
  return ok(res, redactProfit(assignment.toObject(), req.user.role), 'Checked in to job');
});

// POST /work-assignments/:id/checkout  { latitude?, longitude? }
// Caller checks out of the job. Does NOT auto-complete the job.
const checkOutJob = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const assignment = await FieldWorkAssignment.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!assignment) throw new ApiError(404, 'Work assignment not found');

  const me = findMyAssignee(assignment, req.user.employeeId);
  if (!me) throw new ApiError(403, 'You are not assigned to this job');

  me.checkOutAt = new Date();
  me.checkInAt = null;
  const lat = req.body.latitude != null ? Number(req.body.latitude) : null;
  const lng = req.body.longitude != null ? Number(req.body.longitude) : null;
  if (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    me.lastLocation = { latitude: lat, longitude: lng };
  }
  await assignment.save();
  return ok(res, redactProfit(assignment.toObject(), req.user.role), 'Checked out of job');
});

// PATCH /work-assignments/:id/status  { status, note?, reason?, rescheduledTo? }
const updateStatus = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { status } = req.body;
  if (!WORK_ASSIGNMENT_STATUS.includes(status)) {
    throw new ApiError(400, `Invalid status. Allowed: ${WORK_ASSIGNMENT_STATUS.join(', ')}`);
  }
  const filter = { _id: req.params.id, companyId, isDeleted: false };
  // Non-managers may only touch jobs they belong to (primary OR team member).
  if (req.user.role === ROLES.FIELD_EMPLOYEE || req.user.role === ROLES.EMPLOYEE) {
    filter.$or = [{ employeeId: req.user.employeeId }, { 'assignees.employeeId': req.user.employeeId }];
  }
  const assignment = await FieldWorkAssignment.findOne(filter).populate('employeeId', 'userId');
  if (!assignment) throw new ApiError(404, 'Work assignment not found');

  // Managers can set the simple lifecycle statuses (Pending / Ongoing / Hold /
  // Completed / Cancelled) DIRECTLY, bypassing the strict field flow. Field
  // employees still follow the transition map.
  const ADMIN_SETTABLE = ['assigned', 'in_progress', 'on_hold', 'completed', 'cancelled'];
  const adminOverride = isManagerial(req.user.role) && ADMIN_SETTABLE.includes(status);
  const allowed = WORK_ASSIGNMENT_TRANSITIONS[assignment.status] || [];
  if (!adminOverride && !allowed.includes(status)) {
    throw new ApiError(400, `Cannot move assignment from '${assignment.status}' to '${status}'. Allowed: ${allowed.join(', ') || 'none'}`);
  }

  // role rules: cancel/reschedule/hold = managerial; field flow statuses = assigned employee/team
  const managerialOnly = ['cancelled', 'rescheduled', 'assigned', 'on_hold'];
  const fieldFlow = ['accepted', 'rejected', 'on_the_way', 'reached', 'in_progress', 'completed'];
  if (managerialOnly.includes(status) && !isManagerial(req.user.role)) {
    throw new ApiError(403, 'Only managers can cancel or reschedule assignments');
  }
  if (fieldFlow.includes(status) && (req.user.role === ROLES.FIELD_EMPLOYEE || req.user.role === ROLES.EMPLOYEE)) {
    const isPrimary = assignment.employeeId && String(assignment.employeeId._id) === String(req.user.employeeId);
    const isMember = (assignment.assignees || []).some((a) => String(a.employeeId) === String(req.user.employeeId));
    if (!isPrimary && !isMember) {
      throw new ApiError(403, 'You can only update your own assignments');
    }
  }
  if (['checked_in', 'checked_out'].includes(status)) {
    throw new ApiError(400, `'${status}' is set automatically via field visit check-in/checkout`);
  }

  assignment.status = status;
  if (status === 'rejected') assignment.rejectReason = req.body.reason || req.body.note || null;
  if (status === 'cancelled') assignment.cancelReason = req.body.reason || req.body.note || null;
  if (status === 'rescheduled') {
    if (!req.body.rescheduledTo || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.rescheduledTo)) {
      throw new ApiError(400, 'rescheduledTo (YYYY-MM-DD) is required when rescheduling');
    }
    assignment.rescheduledTo = req.body.rescheduledTo;
  }
  assignment.statusHistory.push({ status, by: req.user.userId, note: req.body.note || req.body.reason || null });

  // On completion, mark every member completed and snapshot the TEAM profit math.
  if (status === 'completed') {
    for (const a of assignment.assignees || []) a.status = 'completed';
    if (assignment.jobValue) await persistTeamCosting(assignment, companyId);
  }
  await assignment.save();

  // notify the other party
  if (isManagerial(req.user.role) && assignment.employeeId && assignment.employeeId.userId) {
    await notify({
      companyId,
      userId: assignment.employeeId.userId,
      title: 'Assignment update',
      message: `Assignment "${assignment.title}" is now '${status}'.`,
      type: 'work_assignment',
      meta: { assignmentId: assignment._id },
    });
  } else if (!isManagerial(req.user.role)) {
    await notify({
      companyId,
      userId: assignment.assignedBy,
      title: 'Assignment update',
      message: `${req.user.name} marked "${assignment.title}" as '${status}'.`,
      type: 'work_assignment',
      meta: { assignmentId: assignment._id },
    });
  }
  return ok(res, redactProfit(assignment.toObject(), req.user.role), `Assignment status updated to '${status}'`);
});

// POST /work-assignments/:id/accept — convenience wrapper for the mobile app
const acceptAssignment = (req, res, next) => {
  req.body = { ...req.body, status: 'accepted' };
  return updateStatus(req, res, next);
};

// POST /work-assignments/:id/reject  { reason }
const rejectAssignment = (req, res, next) => {
  req.body = { ...req.body, status: 'rejected' };
  return updateStatus(req, res, next);
};

// PATCH /work-assignments/:id/checklist  { itemId? | itemIndex?, completed?, assigneeId? }
// Assigned team members tick items off; managers tick AND assign tasks to a member.
const updateChecklist = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId, isDeleted: false };
  if (req.user.role === ROLES.FIELD_EMPLOYEE || req.user.role === ROLES.EMPLOYEE) {
    filter.$or = [{ employeeId: req.user.employeeId }, { 'assignees.employeeId': req.user.employeeId }];
  }
  const assignment = await FieldWorkAssignment.findOne(filter);
  if (!assignment) throw new ApiError(404, 'Work assignment not found');

  let item = null;
  if (req.body.itemId) item = assignment.checklist.id(req.body.itemId);
  if (!item && req.body.itemIndex != null) item = assignment.checklist[Number(req.body.itemIndex)];
  if (!item) throw new ApiError(404, 'Checklist item not found');

  if (req.body.completed !== undefined) {
    item.completed = !!req.body.completed;
    item.completedAt = item.completed ? new Date() : null;
  }
  // Assigning a task to a specific member is a managerial action.
  if (req.body.assigneeId !== undefined) {
    if (!isManagerial(req.user.role)) throw new ApiError(403, 'Only managers can assign checklist tasks');
    item.assigneeId = req.body.assigneeId || null;
  }
  await assignment.save();
  return ok(res, assignment, 'Checklist updated');
});

// PATCH /work-assignments/:id/costing — company_admin only.
// Body: { jobValue?, members?:[{ assigneeId|employeeId, daysOverride }] }.
// Sets the job value and/or per-member day overrides, then recomputes & persists
// the TEAM costing (works in any status).
const setCosting = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const assignment = await FieldWorkAssignment.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!assignment) throw new ApiError(404, 'Work assignment not found');
  if (req.body.jobValue !== undefined) assignment.jobValue = Math.max(0, Number(req.body.jobValue) || 0);

  // Ensure a member exists for legacy single-employee jobs so overrides apply.
  if ((!assignment.assignees || !assignment.assignees.length) && assignment.employeeId) {
    assignment.assignees.push({ employeeId: assignment.employeeId, status: 'assigned', workDays: [] });
  }

  // Per-member day overrides (matched by assignee subdoc _id OR employeeId).
  if (Array.isArray(req.body.members)) {
    for (const m of req.body.members) {
      let sub = null;
      if (m.assigneeId) sub = assignment.assignees.id(m.assigneeId);
      if (!sub && m.employeeId) {
        sub = (assignment.assignees || []).find((a) => String(a.employeeId) === String(m.employeeId));
      }
      if (!sub) continue;
      sub.daysOverride = m.daysOverride === null || m.daysOverride === ''
        ? null
        : Math.max(0, Number(m.daysOverride) || 0);
    }
  }

  await persistTeamCosting(assignment, companyId);
  await assignment.save();
  return ok(res, assignment.toObject(), 'Job costing updated');
});

// GET /work-assignments/profitability  ?from&to — company_admin only.
// Per-EMPLOYEE (across every job's team) and per-job profit. Each member is
// attributed a share of profit and job value proportional to their cost.
const profitability = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId, isDeleted: false, jobValue: { $gt: 0 } };
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = req.query.from;
    if (req.query.to) filter.date.$lte = req.query.to;
  }
  const [assignments, company] = await Promise.all([
    FieldWorkAssignment.find(filter)
      .populate('employeeId', 'employeeCode personal.firstName personal.lastName salary job')
      .populate('assignees.employeeId', 'employeeCode personal.firstName personal.lastName salary job')
      .populate('clientId', 'name')
      .sort({ date: -1 }).lean(),
    Company.findById(companyId).select('settings').lean(),
  ]);

  const perEmployee = new Map();
  const jobs = [];
  let totalValue = 0, totalCost = 0, totalProfit = 0;

  for (const a of assignments) {
    const assignees = effectiveAssignees(a);
    // assignees may carry populated employee docs (salary) — build employeesById.
    const employeesById = {};
    for (const m of assignees) {
      const e = m.employeeId;
      if (e && e._id) employeesById[String(e._id)] = e;
    }
    // Fallback: if a synthesized member references the primary populated employeeId.
    if (a.employeeId && a.employeeId._id) employeesById[String(a.employeeId._id)] = a.employeeId;

    const team = computeTeamCosting({ jobValue: a.jobValue, assignees, employeesById, company });
    totalValue += team.jobValue; totalCost += team.totalCost; totalProfit += team.profit;

    const jobMembers = [];
    for (const m of team.members) {
      const e = employeesById[String(m.employeeId && (m.employeeId._id || m.employeeId))] || {};
      const empId = String(e._id || m.employeeId || 'unassigned');
      const name = empName(e);
      // value share = jobValue weighted by this member's cost share.
      const valueShare = team.totalCost > 0
        ? Math.round(team.jobValue * (m.cost / team.totalCost))
        : (team.members.length ? Math.round(team.jobValue / team.members.length) : 0);

      if (!perEmployee.has(empId)) {
        perEmployee.set(empId, {
          employeeId: e._id || m.employeeId || null, name, employeeCode: e.employeeCode || null,
          dailyCost: m.dailyCost, jobs: 0, days: 0, value: 0, cost: 0, profit: 0,
        });
      }
      const pe = perEmployee.get(empId);
      pe.jobs += 1; pe.days += m.daysWorked; pe.cost += m.cost; pe.profit += m.profit; pe.value += valueShare;
      if (m.dailyCost) pe.dailyCost = m.dailyCost;

      jobMembers.push({
        employeeId: e._id || m.employeeId || null, name, role: m.role || null,
        daysWorked: m.daysWorked, cost: m.cost, profit: m.profit,
      });
    }

    jobs.push({
      _id: a._id, title: a.title, date: a.date, status: a.status,
      completed: ['completed', 'checked_out'].includes(a.status),
      client: a.clientId ? a.clientId.name : null,
      jobValue: team.jobValue, totalCost: team.totalCost, profit: team.profit, margin: team.margin,
      members: jobMembers,
    });
  }

  return ok(res, {
    summary: { totalValue, totalCost, totalProfit, jobCount: jobs.length },
    perEmployee: Array.from(perEmployee.values()).sort((x, y) => y.profit - x.profit),
    jobs,
  }, 'Job profitability');
});

// DELETE /work-assignments/:id (manager+)
const deleteAssignment = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const assignment = await FieldWorkAssignment.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!assignment) throw new ApiError(404, 'Work assignment not found');
  assignment.isDeleted = true;
  await assignment.save();
  return ok(res, null, 'Work assignment deleted');
});

module.exports = {
  createAssignment,
  listAssignments,
  myAssignments,
  getAssignment,
  updateAssignment,
  updateStatus,
  acceptAssignment,
  rejectAssignment,
  checkInJob,
  checkOutJob,
  updateChecklist,
  setCosting,
  profitability,
  deleteAssignment,
};
