const fs = require('fs');
const path = require('path');
const EmployeeDocument = require('../models/EmployeeDocument');
const Employee = require('../models/Employee');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isAdminRole } = require('../utils/scope');
const { logAudit } = require('../middleware/audit');
const { toPublicUrl, UPLOAD_ROOT } = require('../middleware/upload');
const { templates } = require('../utils/letterTemplates');
const { notify } = require('../services/notification.service');
const { ROLES, LETTER_TYPES } = require('../constants');

const POPULATE = [
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName userId' },
  { path: 'verifiedBy', select: 'name' },
];

// POST /documents — upload (multipart 'file'; body: employeeId?, type, title)
const uploadDocument = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  let employeeId = req.body.employeeId;
  if (!isAdminRole(req.user.role) && req.user.role !== ROLES.MANAGER) {
    employeeId = req.user.employeeId; // employees upload their own
  }
  if (!employeeId) throw new ApiError(400, 'employeeId is required');
  if (!req.file) throw new ApiError(400, 'file is required');
  const employee = await Employee.findOne({ _id: employeeId, companyId, isDeleted: false });
  if (!employee) throw new ApiError(404, 'Employee not found');

  const doc = await EmployeeDocument.create({
    companyId,
    employeeId,
    type: req.body.type || 'other',
    title: req.body.title || req.file.originalname,
    fileUrl: toPublicUrl(req.file.path),
    fileName: req.file.originalname,
    fileSize: req.file.size || 0,
    uploadedBy: req.user.userId,
    status: 'pending',
  });

  // employee uploading own doc may move onboarding forward
  if (employee.onboardingStatus === 'pending') {
    employee.onboardingStatus = 'document_submitted';
    await employee.save();
  }
  return created(res, doc, 'Document uploaded');
});

// GET /documents
const listDocuments = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId, isDeleted: false };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  const { items, pagination } = await paginate(req.query, EmployeeDocument, filter, {
    searchFields: ['title', 'fileName'],
    populate: POPULATE,
  });
  return ok(res, items, 'Documents', pagination);
});

// PATCH /documents/:id/verify
const verifyDocument = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const doc = await EmployeeDocument.findOne({ _id: req.params.id, companyId, isDeleted: false }).populate(POPULATE);
  if (!doc) throw new ApiError(404, 'Document not found');
  if (doc.status !== 'pending') throw new ApiError(400, `Document is '${doc.status}', expected 'pending'`);
  doc.status = 'verified';
  doc.verifiedBy = req.user.userId;
  doc.verifiedAt = new Date();
  await doc.save();
  if (doc.employeeId.userId) {
    await notify({
      companyId,
      userId: doc.employeeId.userId,
      title: 'Document verified',
      message: `Your document "${doc.title}" has been verified.`,
      type: 'document',
    });
  }
  return ok(res, doc, 'Document verified');
});

// PATCH /documents/:id/reject  { reason? }
const rejectDocument = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const doc = await EmployeeDocument.findOne({ _id: req.params.id, companyId, isDeleted: false }).populate(POPULATE);
  if (!doc) throw new ApiError(404, 'Document not found');
  if (doc.status !== 'pending') throw new ApiError(400, `Document is '${doc.status}', expected 'pending'`);
  doc.status = 'rejected';
  doc.verifiedBy = req.user.userId;
  doc.verifiedAt = new Date();
  doc.rejectionReason = req.body.reason || null;
  await doc.save();
  if (doc.employeeId.userId) {
    await notify({
      companyId,
      userId: doc.employeeId.userId,
      title: 'Document rejected',
      message: `Your document "${doc.title}" was rejected${req.body.reason ? `: ${req.body.reason}` : '.'}`,
      type: 'document',
    });
  }
  return ok(res, doc, 'Document rejected');
});

// DELETE /documents/:id — soft-delete an employee document
const deleteDocument = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const doc = await EmployeeDocument.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!doc) throw new ApiError(404, 'Document not found');
  doc.isDeleted = true;
  await doc.save();
  logAudit(req, { action: 'document.delete', entityType: 'EmployeeDocument', entityId: doc._id, meta: { title: doc.title } });
  return ok(res, null, 'Document deleted');
});

// Shared letter generator — also used by exit completion.
const generateLetterForEmployee = async ({ companyId, employeeId, letterType, userId, extra = {} }) => {
  if (!LETTER_TYPES.includes(letterType)) {
    throw new ApiError(400, `letterType must be one of: ${LETTER_TYPES.join(', ')}`);
  }
  const [company, employee] = await Promise.all([
    Company.findById(companyId).lean(),
    Employee.findOne({ _id: employeeId, companyId }).populate('job.designationId', 'name').lean(),
  ]);
  if (!employee) throw new ApiError(404, 'Employee not found');

  const html = templates[letterType]({
    company,
    employee,
    designation: employee.job.designationId ? employee.job.designationId.name : null,
    ...extra, // template-specific merge fields (newCtc, incrementPercent, effectiveDate, ctc, ...)
    lastWorkingDate: extra.lastWorkingDate || employee.exitDate,
  });

  // persist rendered letter to uploads/<companyId>/letters/
  const dir = path.join(UPLOAD_ROOT, String(companyId), 'letters');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${letterType}-${employee.employeeCode}-${Date.now()}.html`;
  const fullPath = path.join(dir, fileName);
  fs.writeFileSync(fullPath, html, 'utf8');

  const doc = await EmployeeDocument.create({
    companyId,
    employeeId,
    type: 'letter',
    title: `${letterType.replace(/_/g, ' ')} letter`,
    fileUrl: toPublicUrl(fullPath),
    fileName,
    uploadedBy: userId,
    status: 'verified',
    verifiedBy: userId,
    verifiedAt: new Date(),
    isGenerated: true,
    letterType,
  });
  return { doc, html };
};

// POST /documents/generate  { employeeId, letterType, lastWorkingDate?, ctc?, extra?, updateSalary? } → rendered HTML
// Increment letters: extra = { newCtc, effectiveDate, incrementPercent? }; updateSalary === true also revises salary.ctc.
const generateLetter = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { employeeId, letterType } = req.body;
  if (!employeeId) throw new ApiError(400, 'employeeId is required');
  const extra = { lastWorkingDate: req.body.lastWorkingDate, ctc: req.body.ctc, ...(req.body.extra || {}) };

  const updateSalary = req.body.updateSalary === true;
  if (updateSalary && !(Number(extra.newCtc) > 0)) {
    throw new ApiError(400, 'extra.newCtc (> 0) is required when updateSalary is true');
  }

  const { doc, html } = await generateLetterForEmployee({
    companyId,
    employeeId,
    letterType,
    userId: req.user.userId,
    extra,
  });

  if (updateSalary) {
    const employee = await Employee.findOne({ _id: employeeId, companyId });
    if (!employee) throw new ApiError(404, 'Employee not found');
    const oldCtc = employee.salary.ctc;
    employee.salary.ctc = Number(extra.newCtc);
    await employee.save();
    logAudit(req, {
      action: 'employee.salary_change',
      entityType: 'Employee',
      entityId: employee._id,
      meta: { oldCtc, newCtc: employee.salary.ctc, letterType, effectiveDate: extra.effectiveDate },
    });
  }
  return created(res, { document: doc, html }, 'Letter generated');
});

// GET /documents/:id/render — returns the stored generated letter HTML
const renderDocument = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId, isDeleted: false };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) filter.employeeId = req.user.employeeId;
  const doc = await EmployeeDocument.findOne(filter).lean();
  if (!doc) throw new ApiError(404, 'Document not found');
  if (!doc.isGenerated || !doc.fileUrl) throw new ApiError(400, 'Only generated letters can be rendered');
  const fullPath = path.join(UPLOAD_ROOT, doc.fileUrl.replace('/uploads/', ''));
  if (!fs.existsSync(fullPath)) throw new ApiError(404, 'Letter file missing on disk');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(fs.readFileSync(fullPath, 'utf8'));
});

module.exports = {
  uploadDocument,
  listDocuments,
  verifyDocument,
  rejectDocument,
  deleteDocument,
  generateLetter,
  renderDocument,
  generateLetterForEmployee,
};
