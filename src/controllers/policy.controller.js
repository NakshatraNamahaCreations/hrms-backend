const Policy = require('../models/Policy');
const PolicyAck = require('../models/PolicyAck');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { toPublicUrl } = require('../middleware/upload');
const { ROLES } = require('../constants');

const POPULATE = [{ path: 'createdBy', select: 'name' }];

// POST /policies (HR+) — multipart 'file' or body.url
const createPolicy = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { title } = req.body;
  if (!title) throw new ApiError(400, 'title is required');
  const fileUrl = req.file ? toPublicUrl(req.file.path) : req.body.url || null;

  const policy = await Policy.create({
    companyId,
    title,
    description: req.body.description || '',
    fileUrl,
    active: req.body.active !== undefined ? req.body.active !== 'false' && Boolean(req.body.active) : true,
    createdBy: req.user.userId,
  });
  return created(res, policy, 'Policy created');
});

// GET /policies — employees see active only; every row carries `acknowledged` for self
const listPolicies = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId, isDeleted: false };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.active = true;
  } else if (req.query.active !== undefined) {
    filter.active = req.query.active === 'true';
  }
  const { items, pagination } = await paginate(req.query, Policy, filter, {
    searchFields: ['title', 'description'],
    populate: POPULATE,
  });

  // self acknowledgement flags in one query
  if (req.user.employeeId && items.length) {
    const acks = await PolicyAck.find({
      companyId,
      employeeId: req.user.employeeId,
      policyId: { $in: items.map((p) => p._id) },
    }).lean();
    const ackByPolicy = new Map(acks.map((a) => [String(a.policyId), a.acknowledgedAt]));
    for (const item of items) {
      item.acknowledged = ackByPolicy.has(String(item._id));
      item.acknowledgedAt = ackByPolicy.get(String(item._id)) || null;
    }
  } else {
    for (const item of items) item.acknowledged = false;
  }
  return ok(res, items, 'Policies', pagination);
});

// PUT /policies/:id (HR+) — version bumps when the file changes
const updatePolicy = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const policy = await Policy.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!policy) throw new ApiError(404, 'Policy not found');

  if (req.body.title !== undefined) policy.title = req.body.title;
  if (req.body.description !== undefined) policy.description = req.body.description;
  if (req.body.active !== undefined) policy.active = req.body.active !== 'false' && Boolean(req.body.active);
  if (req.file) {
    policy.fileUrl = toPublicUrl(req.file.path);
    policy.version += 1;
  } else if (req.body.url && req.body.url !== policy.fileUrl) {
    policy.fileUrl = req.body.url;
    policy.version += 1;
  }
  await policy.save();
  return ok(res, policy, 'Policy updated');
});

// DELETE /policies/:id (HR+)
const deletePolicy = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const policy = await Policy.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!policy) throw new ApiError(404, 'Policy not found');
  policy.isDeleted = true;
  await policy.save();
  return ok(res, null, 'Policy deleted');
});

// POST /policies/:id/acknowledge — once per employee
const acknowledgePolicy = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const policy = await Policy.findOne({ _id: req.params.id, companyId, isDeleted: false, active: true });
  if (!policy) throw new ApiError(404, 'Policy not found or inactive');

  const existing = await PolicyAck.findOne({ policyId: policy._id, employeeId: req.user.employeeId });
  if (existing) throw new ApiError(409, 'You have already acknowledged this policy');

  const ack = await PolicyAck.create({
    companyId,
    policyId: policy._id,
    employeeId: req.user.employeeId,
    acknowledgedAt: new Date(),
  });
  return created(res, ack, 'Policy acknowledged');
});

// GET /policies/:id/acks (HR+) — acknowledgement status across active employees
const listAcks = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const policy = await Policy.findOne({ _id: req.params.id, companyId, isDeleted: false }).lean();
  if (!policy) throw new ApiError(404, 'Policy not found');

  const [employees, acks] = await Promise.all([
    Employee.find({ companyId, isDeleted: false, status: 'active' })
      .select('employeeCode personal.firstName personal.lastName')
      .sort({ employeeCode: 1 })
      .lean(),
    PolicyAck.find({ companyId, policyId: policy._id }).lean(),
  ]);
  const ackByEmployee = new Map(acks.map((a) => [String(a.employeeId), a.acknowledgedAt]));
  const rows = employees.map((emp) => ({
    employee: {
      _id: emp._id,
      employeeCode: emp.employeeCode,
      name: `${emp.personal.firstName} ${emp.personal.lastName || ''}`.trim(),
    },
    acknowledgedAt: ackByEmployee.get(String(emp._id)) || null,
  }));
  return ok(res, rows, 'Policy acknowledgements');
});

module.exports = { createPolicy, listPolicies, updatePolicy, deletePolicy, acknowledgePolicy, listAcks };
