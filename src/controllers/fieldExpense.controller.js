const dayjs = require('dayjs');
const FieldExpense = require('../models/FieldExpense');
const FieldWorkAssignment = require('../models/FieldWorkAssignment');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { toPublicUrl } = require('../middleware/upload');
const { notify } = require('../services/notification.service');
const { ROLES } = require('../constants');

const POPULATE = [
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName userId' },
  { path: 'workAssignmentId', select: 'title date' },
];

// POST /field/expenses — submit (multipart optional 'receipt')
const submitExpense = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const { amount } = req.body;
  const category = req.body.category || req.body.expenseType; // mobile sends expenseType
  if (amount == null || Number(amount) <= 0) throw new ApiError(400, 'A positive amount is required');

  if (req.body.workAssignmentId) {
    const assignment = await FieldWorkAssignment.findOne({
      _id: req.body.workAssignmentId,
      companyId,
      employeeId: req.user.employeeId,
    });
    if (!assignment) throw new ApiError(404, 'Work assignment not found');
  }

  const expense = await FieldExpense.create({
    companyId,
    employeeId: req.user.employeeId,
    workAssignmentId: req.body.workAssignmentId || null,
    date: req.body.date || dayjs().format('YYYY-MM-DD'),
    category: category || 'travel',
    amount: Number(amount),
    description: req.body.description || null,
    receipt: req.file ? toPublicUrl(req.file.path) : null,
  });
  return created(res, expense, 'Expense submitted');
});

// GET /field/expenses
const listExpenses = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if (req.user.role === ROLES.FIELD_EMPLOYEE || req.user.role === ROLES.EMPLOYEE) {
    filter.employeeId = req.user.employeeId;
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.workAssignmentId) filter.workAssignmentId = req.query.workAssignmentId;
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = req.query.from;
    if (req.query.to) filter.date.$lte = req.query.to;
  }
  const { items, pagination } = await paginate(req.query, FieldExpense, filter, {
    searchFields: ['category', 'description', 'status', 'date'],
    sortable: ['date', 'amount', 'category', 'status', 'createdAt', 'updatedAt'],
    populate: POPULATE,
  });
  return ok(res, items, 'Field expenses', pagination);
});

const actOnExpense = async (req, expectedStatus, newStatus, extra = {}) => {
  const companyId = getCompanyId(req);
  const expense = await FieldExpense.findOne({ _id: req.params.id, companyId }).populate('employeeId', 'userId');
  if (!expense) throw new ApiError(404, 'Expense not found');
  if (!expectedStatus.includes(expense.status)) {
    throw new ApiError(400, `Expense is '${expense.status}', expected one of: ${expectedStatus.join(', ')}`);
  }
  Object.assign(expense, extra, { status: newStatus });
  await expense.save();
  if (expense.employeeId && expense.employeeId.userId) {
    await notify({
      companyId,
      userId: expense.employeeId.userId,
      title: `Expense ${newStatus}`,
      message: `Your expense of ₹${expense.amount} (${expense.category}) on ${expense.date} is now '${newStatus}'.`,
      type: 'expense',
    });
  }
  return expense;
};

// PATCH /field/expenses/:id/approve
const approveExpense = asyncHandler(async (req, res) => {
  const expense = await actOnExpense(req, ['submitted'], 'approved', {
    actionBy: req.user.userId,
    actionAt: new Date(),
  });
  return ok(res, expense, 'Expense approved');
});

// PATCH /field/expenses/:id/reject  { reason? }
const rejectExpense = asyncHandler(async (req, res) => {
  const expense = await actOnExpense(req, ['submitted'], 'rejected', {
    actionBy: req.user.userId,
    actionAt: new Date(),
    rejectionReason: req.body.reason || null,
  });
  return ok(res, expense, 'Expense rejected');
});

// PATCH /field/expenses/:id/mark-paid
const markPaid = asyncHandler(async (req, res) => {
  const expense = await actOnExpense(req, ['approved'], 'paid', {
    paidAt: new Date(),
    paidBy: req.user.userId,
  });
  return ok(res, expense, 'Expense marked as paid');
});

module.exports = { submitExpense, listExpenses, approveExpense, rejectExpense, markPaid };
