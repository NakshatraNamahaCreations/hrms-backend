const crypto = require('crypto');
const fs = require('fs');
const dayjs = require('dayjs');
const Employee = require('../models/Employee');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanySubscription = require('../models/CompanySubscription');
const LeaveBalance = require('../models/LeaveBalance');
const EmployeeDocument = require('../models/EmployeeDocument');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Designation = require('../models/Designation');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const generateEmployeeCode = require('../utils/generateEmployeeCode');
const { notify } = require('../services/notification.service');
const { logAudit } = require('../middleware/audit');
const { toPublicUrl } = require('../middleware/upload');
const { generateLetterForEmployee } = require('./document.controller');
const employeeInsights = require('../services/employeeInsights.service');
const { ROLES, ONBOARDING_STATUS } = require('../constants');

const POPULATE = [
  { path: 'job.branchId', select: 'name' },
  { path: 'job.departmentId', select: 'name' },
  { path: 'job.designationId', select: 'name' },
  { path: 'job.shiftId', select: 'name startTime endTime' },
  { path: 'job.managerId', select: 'employeeCode personal.firstName personal.lastName' },
];

// Ratings are compensation-adjacent: only the roles that already see salary
// data get them. Everyone else gets a list with no `performance` key at all,
// so the client can hide the column rather than render an empty one.
const PERFORMANCE_ROLES = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN];

const ALLOWED_LOGIN_ROLES = [ROLES.HR_ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE, ROLES.PAYROLL_ADMIN];

// Enforces the plan's employee / field employee limits before creating a new employee.
const enforcePlanLimits = async (companyId, employeeType) => {
  const sub = await CompanySubscription.findOne({ companyId }).sort({ createdAt: -1 }).lean();
  if (!sub) throw new ApiError(402, 'No subscription found for your company');
  const [total, field] = await Promise.all([
    Employee.countDocuments({ companyId, isDeleted: false, status: { $ne: 'exited' } }),
    Employee.countDocuments({ companyId, isDeleted: false, status: { $ne: 'exited' }, 'job.employeeType': 'field_employee' }),
  ]);
  if (sub.employeeLimit && total >= sub.employeeLimit) {
    throw new ApiError(403, `Employee limit (${sub.employeeLimit}) reached for your plan. Upgrade to add more employees.`);
  }
  if (employeeType === 'field_employee' && sub.fieldEmployeeLimit && field >= sub.fieldEmployeeLimit) {
    throw new ApiError(403, `Field employee limit (${sub.fieldEmployeeLimit}) reached for your plan. Upgrade to add more field employees.`);
  }
};

const initLeaveBalance = async (companyId, employeeId) => {
  const company = await Company.findById(companyId).select('settings.leavePolicy').lean();
  const policy = (company && company.settings && company.settings.leavePolicy) || { casual: 12, sick: 8, earned: 15 };
  const year = new Date().getFullYear();
  await LeaveBalance.findOneAndUpdate(
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
};

// Core creation path shared by single create and bulk import: plan limits,
// employee record, linked login user, leave-balance init and welcome notification.
const createEmployeeRecord = async (companyId, payload, actingUser) => {
  const { personal = {}, job = {}, salary = {}, bank = {}, field = {} } = payload;
  if (!personal.firstName || !personal.email) {
    throw new ApiError(400, 'personal.firstName and personal.email are required');
  }
  const employeeType = job.employeeType || (field.isFieldEmployee ? 'field_employee' : 'office_employee');
  await enforcePlanLimits(companyId, employeeType);

  const email = String(personal.email).toLowerCase().trim();
  const existingUser = await User.findOne({ email });
  if (existingUser) throw new ApiError(409, 'A login already exists with this email');

  const employeeCode = payload.employeeCode || (await generateEmployeeCode(companyId));
  const employee = await Employee.create({
    companyId,
    employeeCode,
    personal: { ...personal, email },
    job: { ...job, employeeType },
    salary,
    bank,
    field: { ...field, isFieldEmployee: employeeType === 'field_employee' },
    biometricUserId: payload.biometricUserId || null,
    onboardingStatus: 'pending',
  });

  // linked login account with temp password
  let role = payload.role || (employeeType === 'field_employee' ? ROLES.FIELD_EMPLOYEE : ROLES.EMPLOYEE);
  if (!ALLOWED_LOGIN_ROLES.includes(role)) role = ROLES.EMPLOYEE;
  const tempPassword = payload.password || `Temp@${crypto.randomBytes(3).toString('hex')}`;
  const user = await User.create({
    companyId,
    employeeId: employee._id,
    name: `${personal.firstName} ${personal.lastName || ''}`.trim(),
    email,
    password: tempPassword,
    role,
  });
  employee.userId = user._id;
  await employee.save();

  await initLeaveBalance(companyId, employee._id);

  await notify({
    companyId,
    userId: user._id,
    title: 'Welcome aboard!',
    message: `Your employee account has been created. Login email: ${email}, temporary password: ${tempPassword}. Please change it after first login.`,
    type: 'account',
    channels: ['email'],
  });

  return { employee, user, tempPassword };
};

// POST /employees
const createEmployee = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { employee, tempPassword } = await createEmployeeRecord(companyId, req.body, req.user);
  res.locals.auditEntityId = employee._id;
  return created(res, { employee, tempPassword }, 'Employee created');
});

// GET /employees
const listEmployees = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId, isDeleted: false };

  // Saved view (all | active | probation | notice | incomplete | exited). It may
  // resolve to a plain filter, an id list, or both.
  const idSets = [];
  if (req.query.view) {
    const scope = await employeeInsights.viewScope(companyId, req.query.view);
    Object.assign(filter, scope.filter);
    if (scope.ids) idSets.push(scope.ids);
  }
  // Signal chips (drift / lowConfidence / keyPerson / birthday / probationDue).
  const signal = await employeeInsights.signalIds(companyId, req.query);
  if (signal) idSets.push(signal);
  if (idSets.length) {
    // Intersect so several chips narrow rather than widen.
    const ids = idSets.reduce((acc, list) => acc.filter((x) => new Set(list).has(x)));
    filter._id = { $in: ids };
  }

  if (req.query.branchId) filter['job.branchId'] = req.query.branchId;
  if (req.query.departmentId) filter['job.departmentId'] = req.query.departmentId;
  if (req.query.designationId) filter['job.designationId'] = req.query.designationId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.employmentType) filter['job.employmentType'] = req.query.employmentType;
  if (req.query.employeeType) filter['job.employeeType'] = req.query.employeeType;
  if (req.query.onboardingStatus) filter.onboardingStatus = req.query.onboardingStatus;
  if (req.query.managerId) filter['job.managerId'] = req.query.managerId;

  const { items, pagination } = await paginate(req.query, Employee, filter, {
    searchFields: ['personal.firstName', 'personal.lastName', 'personal.email', 'employeeCode', 'personal.phone'],
    sortable: ['createdAt', 'updatedAt', 'employeeCode', 'personal.firstName', 'personal.lastName', 'personal.email', 'status', 'job.joiningDate'],
    populate: POPULATE,
    select: '-salary -bank',
  });

  // ?enrich=1 adds the derived directory columns (30-day attendance strip,
  // profile completeness, key-person risk, notice period). Off by default so
  // existing callers keep the cheap query.
  if (req.query.enrich === '1' || req.query.enrich === 'true') {
    const rows = await employeeInsights.enrich(companyId, items, {
      includePerformance: PERFORMANCE_ROLES.includes(req.user.role),
    });
    return ok(res, rows, 'Employees', pagination);
  }
  return ok(res, items, 'Employees', pagination);
});

// GET /employees/overview — saved-view counts and signal counts for the directory
const employeeOverview = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const data = await employeeInsights.overview(companyId);
  return ok(res, { ...data, canSeePerformance: PERFORMANCE_ROLES.includes(req.user.role) }, 'Employee overview');
});

// GET /employees/:id
const getEmployee = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId, isDeleted: false };
  // employees may only view themselves
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role) && String(req.user.employeeId) !== String(req.params.id)) {
    throw new ApiError(403, 'You can only view your own profile');
  }
  const employee = await Employee.findOne(filter).populate(POPULATE).lean();
  if (!employee) throw new ApiError(404, 'Employee not found');
  const documents = await EmployeeDocument.find({ companyId, employeeId: employee._id, isDeleted: false }).lean();
  const user = employee.userId ? await User.findById(employee.userId).select('email role isActive lastLoginAt').lean() : null;
  return ok(res, { ...employee, documents, account: user }, 'Employee detail');
});

// PUT /employees/:id — multi-section update { personal?, job?, salary?, bank?, field?, biometricUserId?, status? }
const updateEmployee = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const employee = await Employee.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!employee) throw new ApiError(404, 'Employee not found');

  const sections = ['personal', 'job', 'salary', 'bank', 'field'];
  const doc = employee.toObject();
  for (const section of sections) {
    if (req.body[section] && typeof req.body[section] === 'object') {
      if (section === 'salary') {
        logAudit(req, {
          action: 'employee.salary_change',
          entityType: 'Employee',
          entityId: employee._id,
          meta: { before: doc.salary, after: { ...doc.salary, ...req.body.salary } },
        });
      }
      employee[section] = { ...doc[section], ...req.body[section] };
      employee.markModified(section);
    }
  }
  if (req.body.biometricUserId !== undefined) employee.biometricUserId = req.body.biometricUserId;
  if (req.body.status !== undefined) employee.status = req.body.status;
  if (req.body.job && req.body.job.employeeType) {
    employee.field.isFieldEmployee = req.body.job.employeeType === 'field_employee';
  }
  await employee.save();

  // keep linked login in sync
  if (employee.userId && (req.body.personal || req.body.status !== undefined)) {
    const update = {};
    if (req.body.personal) {
      update.name = `${employee.personal.firstName} ${employee.personal.lastName || ''}`.trim();
    }
    if (req.body.status !== undefined) update.isActive = employee.status === 'active';
    await User.findByIdAndUpdate(employee.userId, { $set: update });
  }

  // HR/admin can set or reset the employee's mobile-app login password from the edit form
  if (employee.userId && req.body.password) {
    if (String(req.body.password).length < 8) throw new ApiError(400, 'Password must be at least 8 characters');
    const loginUser = await User.findById(employee.userId);
    if (loginUser) {
      loginUser.password = req.body.password; // pre-save hook hashes it
      await loginUser.save();
    }
  }
  return ok(res, employee, 'Employee updated');
});

// PATCH /employees/:id/onboarding-status { status }
const updateOnboardingStatus = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { status } = req.body;
  if (!ONBOARDING_STATUS.includes(status)) {
    throw new ApiError(400, `Invalid onboarding status. Allowed: ${ONBOARDING_STATUS.join(', ')}`);
  }
  const employee = await Employee.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!employee) throw new ApiError(404, 'Employee not found');

  const currentIdx = ONBOARDING_STATUS.indexOf(employee.onboardingStatus);
  const nextIdx = ONBOARDING_STATUS.indexOf(status);
  if (nextIdx < currentIdx) throw new ApiError(400, `Cannot move onboarding back from '${employee.onboardingStatus}' to '${status}'`);

  employee.onboardingStatus = status;
  await employee.save();
  if (employee.userId) {
    await notify({
      companyId,
      userId: employee.userId,
      title: 'Onboarding update',
      message: `Your onboarding status is now '${status.replace(/_/g, ' ')}'.`,
      type: 'onboarding',
    });
  }
  return ok(res, employee, 'Onboarding status updated');
});

// DELETE /employees/:id (soft)
const deleteEmployee = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const employee = await Employee.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!employee) throw new ApiError(404, 'Employee not found');
  employee.isDeleted = true;
  employee.status = 'inactive';
  await employee.save();
  if (employee.userId) await User.findByIdAndUpdate(employee.userId, { $set: { isActive: false } });
  logAudit(req, { action: 'employee.delete', entityType: 'Employee', entityId: employee._id });
  return ok(res, null, 'Employee deleted');
});

// POST /employees/:id/documents (multipart: file, fields: type, title)
const uploadDocument = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const employee = await Employee.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!employee) throw new ApiError(404, 'Employee not found');
  if (!req.file) throw new ApiError(400, 'file is required');
  const doc = await EmployeeDocument.create({
    companyId,
    employeeId: employee._id,
    type: req.body.type || 'other',
    title: req.body.title || req.file.originalname,
    fileUrl: toPublicUrl(req.file.path),
    fileName: req.file.originalname,
    uploadedBy: req.user.userId,
    status: 'pending',
  });
  return created(res, doc, 'Document uploaded');
});

// GET /employees/probation-due?days=30 (HR+)
const probationDue = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const days = Math.max(parseInt(req.query.days, 10) || 30, 1);
  const cutoff = dayjs().add(days, 'day').endOf('day').toDate();
  const employees = await Employee.find({
    companyId,
    isDeleted: false,
    status: 'active',
    'job.confirmationStatus': 'probation',
    'job.probationEndDate': { $ne: null, $lte: cutoff },
  })
    .select('employeeCode personal.firstName personal.lastName personal.photo job.probationEndDate job.joiningDate job.departmentId job.designationId')
    .populate([
      { path: 'job.departmentId', select: 'name' },
      { path: 'job.designationId', select: 'name' },
    ])
    .sort({ 'job.probationEndDate': 1 })
    .lean();
  return ok(res, employees, 'Employees with probation due');
});

// PATCH /employees/:id/confirm { action: 'confirm'|'extend', newProbationEndDate? }
const confirmEmployee = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { action } = req.body;
  if (!['confirm', 'extend'].includes(action)) {
    throw new ApiError(400, "action must be 'confirm' or 'extend'");
  }
  const employee = await Employee.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!employee) throw new ApiError(404, 'Employee not found');

  if (action === 'extend') {
    if (!req.body.newProbationEndDate) {
      throw new ApiError(400, 'newProbationEndDate is required to extend probation');
    }
    const previousEndDate = employee.job.probationEndDate;
    employee.job.probationEndDate = new Date(req.body.newProbationEndDate);
    employee.job.confirmationStatus = 'probation';
    employee.markModified('job');
    await employee.save();
    logAudit(req, {
      action: 'employee.probation_extend',
      entityType: 'Employee',
      entityId: employee._id,
      meta: { from: previousEndDate, to: employee.job.probationEndDate },
    });
    if (employee.userId) {
      await notify({
        companyId,
        userId: employee.userId,
        title: 'Probation extended',
        message: `Your probation period has been extended until ${dayjs(employee.job.probationEndDate).format('DD MMM YYYY')}.`,
        type: 'employee',
      });
    }
    return ok(res, employee, 'Probation extended');
  }

  if (employee.job.confirmationStatus === 'confirmed') {
    throw new ApiError(400, 'Employee is already confirmed');
  }
  employee.job.confirmationStatus = 'confirmed';
  employee.markModified('job');
  await employee.save();

  // confirmation letter via the letter engine (failure must not block confirmation)
  let letter = null;
  try {
    const result = await generateLetterForEmployee({
      companyId,
      employeeId: employee._id,
      letterType: 'confirmation',
      userId: req.user.userId,
    });
    letter = result.doc;
  } catch (e) {
    /* letter generation is best-effort */
  }

  logAudit(req, { action: 'employee.confirm', entityType: 'Employee', entityId: employee._id });
  if (employee.userId) {
    await notify({
      companyId,
      userId: employee.userId,
      title: 'Congratulations — you are confirmed!',
      message: 'You have successfully completed your probation and are now a confirmed employee.',
      type: 'employee',
      channels: ['email'],
    });
  }
  return ok(res, { employee, letter }, 'Employee confirmed');
});

// --- Bulk import -------------------------------------------------------------

const IMPORT_COLUMNS = [
  'firstName', 'lastName', 'email', 'phone', 'employeeType', 'role', 'joiningDate',
  'basicSalary', 'hra', 'branch', 'department', 'designation', 'password',
];

// GET /employees/import-template — CSV header + sample row
const importTemplate = asyncHandler(async (req, res) => {
  const sample = [
    'Ravi', 'Kumar', 'ravi.kumar@example.com', '+91-9000000099', 'office_employee', 'employee',
    dayjs().format('YYYY-MM-DD'), '25000', '12500', 'Head Office', 'Operations', 'Executive', 'Welcome@123',
  ];
  const csv = `${IMPORT_COLUMNS.join(',')}\n${sample.join(',')}\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employee-import-template.csv"');
  return res.send(csv);
});

// Minimal CSV parser — handles quoted cells with commas and escaped ("") quotes.
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Case-insensitive name → document lookup within the company (cached per request).
const resolveByName = async (Model, companyId, name, cache) => {
  const key = String(name).trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const doc = await Model.findOne({
    companyId,
    isDeleted: { $ne: true },
    name: { $regex: `^${escapeRegex(String(name).trim())}$`, $options: 'i' },
  }).lean();
  cache.set(key, doc);
  return doc;
};

// POST /employees/bulk-import (multipart 'file', HR+) → { created, failed: [{row, email, error}] }
const bulkImport = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  if (!req.file) throw new ApiError(400, "A CSV file is required (multipart field 'file')");

  const text = fs.readFileSync(req.file.path, 'utf8').replace(/^﻿/, ''); // strip BOM
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ApiError(400, 'CSV must contain a header row and at least one data row');

  // map columns by header name (any order, case-insensitive)
  const header = rows[0].map((h) => String(h).trim());
  const colIndex = {};
  for (const col of IMPORT_COLUMNS) {
    colIndex[col] = header.findIndex((h) => h.toLowerCase() === col.toLowerCase());
  }
  if (colIndex.firstName === -1 || colIndex.email === -1) {
    throw new ApiError(400, "CSV header must include at least 'firstName' and 'email' columns");
  }
  const cell = (row, col) => (colIndex[col] >= 0 ? String(row[colIndex[col]] || '').trim() : '');

  const caches = { branch: new Map(), department: new Map(), designation: new Map() };
  let createdCount = 0;
  const failed = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNumber = i + 1; // 1-based incl. header
    const email = cell(row, 'email');
    try {
      const branchName = cell(row, 'branch');
      const departmentName = cell(row, 'department');
      const designationName = cell(row, 'designation');

      /* eslint-disable no-await-in-loop */
      const branch = branchName ? await resolveByName(Branch, companyId, branchName, caches.branch) : null;
      if (branchName && !branch) throw new ApiError(400, `Branch '${branchName}' not found`);
      const department = departmentName ? await resolveByName(Department, companyId, departmentName, caches.department) : null;
      if (departmentName && !department) throw new ApiError(400, `Department '${departmentName}' not found`);
      const designation = designationName ? await resolveByName(Designation, companyId, designationName, caches.designation) : null;
      if (designationName && !designation) throw new ApiError(400, `Designation '${designationName}' not found`);

      const joiningDate = cell(row, 'joiningDate');
      const payload = {
        personal: {
          firstName: cell(row, 'firstName'),
          lastName: cell(row, 'lastName'),
          email,
          phone: cell(row, 'phone') || null,
        },
        job: {
          employeeType: cell(row, 'employeeType') || 'office_employee',
          joiningDate: joiningDate ? new Date(joiningDate) : null,
          branchId: branch ? branch._id : null,
          departmentId: department ? department._id : null,
          designationId: designation ? designation._id : null,
        },
        salary: {
          basic: Number(cell(row, 'basicSalary')) || 0,
          hra: Number(cell(row, 'hra')) || 0,
        },
        role: cell(row, 'role') || null,
        password: cell(row, 'password') || null,
      };
      await createEmployeeRecord(companyId, payload, req.user);
      /* eslint-enable no-await-in-loop */
      createdCount += 1;
    } catch (e) {
      failed.push({ row: rowNumber, email: email || null, error: e.message });
    }
  }

  logAudit(req, {
    action: 'employee.bulk_import',
    entityType: 'Employee',
    meta: { created: createdCount, failed: failed.length },
  });
  return ok(res, { created: createdCount, failed }, `Imported ${createdCount} employee(s), ${failed.length} failed`);
});

// GET /employees/org-chart — forest built from job.managerId
const orgChart = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const employees = await Employee.find({ companyId, isDeleted: false, status: 'active' })
    .select('employeeCode personal.firstName personal.lastName personal.photo job.managerId job.designationId')
    .populate('job.designationId', 'name')
    .lean();

  const nodes = new Map();
  for (const e of employees) {
    nodes.set(String(e._id), {
      _id: e._id,
      name: `${e.personal.firstName} ${e.personal.lastName || ''}`.trim(),
      designation: e.job && e.job.designationId ? e.job.designationId.name : null,
      employeeCode: e.employeeCode,
      photo: (e.personal && e.personal.photo) || null,
      children: [],
    });
  }
  const roots = [];
  for (const e of employees) {
    const node = nodes.get(String(e._id));
    const managerId = e.job && e.job.managerId ? String(e.job.managerId) : null;
    const manager = managerId && managerId !== String(e._id) ? nodes.get(managerId) : null;
    if (manager) manager.children.push(node);
    else roots.push(node);
  }
  return ok(res, roots, 'Org chart');
});

module.exports = {
  createEmployee,
  createEmployeeRecord,
  listEmployees,
  employeeOverview,
  getEmployee,
  updateEmployee,
  updateOnboardingStatus,
  deleteEmployee,
  uploadDocument,
  probationDue,
  confirmEmployee,
  importTemplate,
  bulkImport,
  orgChart,
};
