const mongoose = require('mongoose');
const dayjs = require('dayjs');
const Loan = require('../models/Loan');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { paginateArray } = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isAdminRole } = require('../utils/scope');
const { notify } = require('../services/notification.service');
const { postLoanPayment } = require('../services/loan.service');
const { logAudit } = require('../middleware/audit');
const { ROLES, LOAN_TYPES, LOAN_PAYMENT_METHODS } = require('../constants');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const POPULATE = [
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName userId' },
  { path: 'approvedBy', select: 'name' },
];

const canAdminister = (role) => isAdminRole(role) || role === ROLES.PAYROLL_ADMIN;

// POST /loans — employee requests a loan/advance (admins may raise for an employee)
const requestLoan = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { amount } = req.body;
  if (amount == null || Number(amount) <= 0) throw new ApiError(400, 'A positive amount is required');
  const type = req.body.type || 'loan';
  if (!LOAN_TYPES.includes(type)) throw new ApiError(400, `type must be one of: ${LOAN_TYPES.join(', ')}`);

  let employeeId = req.user.employeeId;
  if (canAdminister(req.user.role) && req.body.employeeId) employeeId = req.body.employeeId;
  if (!employeeId) throw new ApiError(400, 'No employee profile linked to your account');

  const employee = await Employee.findOne({ _id: employeeId, companyId, isDeleted: false, status: 'active' });
  if (!employee) throw new ApiError(404, 'Employee not found or inactive');

  const loan = await Loan.create({
    companyId,
    employeeId,
    type,
    amount: Number(amount),
    reason: req.body.reason || null,
  });
  res.locals.auditEntityId = loan._id;
  return created(res, loan, 'Loan request submitted');
});

// GET /loans — admins see all (with filters); employees see own only
const listLoans = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if (!canAdminister(req.user.role) && req.user.role !== ROLES.MANAGER) {
    filter.employeeId = req.user.employeeId;
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  const { items, pagination } = await paginate(req.query, Loan, filter, {
    searchFields: ['type', 'status', 'reason'],
    sortable: ['createdAt', 'updatedAt', 'amount', 'balance', 'status', 'type'],
    populate: POPULATE,
  });
  return ok(res, items, 'Loans', pagination);
});

// GET /loans/outstanding (payroll_admin+) — per-employee totals of disbursed balances
const outstanding = asyncHandler(async (req, res) => {
  const companyId = new mongoose.Types.ObjectId(String(getCompanyId(req)));
  const rows = await Loan.aggregate([
    { $match: { companyId, status: 'disbursed', balance: { $gt: 0 } } },
    {
      $group: {
        _id: '$employeeId',
        loans: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        totalBalance: { $sum: '$balance' },
        monthlyEmi: { $sum: { $min: ['$emiAmount', '$balance'] } },
      },
    },
    { $sort: { totalBalance: -1 } },
  ]);

  const employees = await Employee.find({ _id: { $in: rows.map((r) => r._id) } })
    .select('employeeCode personal.firstName personal.lastName')
    .lean();
  const byId = new Map(employees.map((e) => [String(e._id), e]));
  const items = rows.map((row) => {
    const emp = byId.get(String(row._id));
    return {
      employeeId: row._id,
      employeeCode: emp ? emp.employeeCode : null,
      name: emp ? `${emp.personal.firstName} ${emp.personal.lastName || ''}`.trim() : null,
      loans: row.loans,
      totalAmount: row.totalAmount,
      totalBalance: row.totalBalance,
      monthlyEmi: row.monthlyEmi,
    };
  });
  // v1.5 list contract over the aggregated rows — slicing is OPT-IN (only when
  // ?page/?limit are sent); totals cover the whole search-filtered set, not just the page.
  const needle = String(req.query.search || '').trim().toLowerCase();
  const filtered = needle
    ? items.filter((r) => [r.employeeCode, r.name].some((v) => v && String(v).toLowerCase().includes(needle)))
    : items;
  const { items: pageRows, pagination } = paginateArray({ ...req.query, search: undefined }, filtered, {
    sortable: {
      employeeCode: (r) => r.employeeCode || '',
      name: (r) => (r.name || '').toLowerCase(),
      loans: (r) => r.loans,
      totalAmount: (r) => r.totalAmount,
      totalBalance: (r) => r.totalBalance,
      monthlyEmi: (r) => r.monthlyEmi,
    },
  });
  const totals = filtered.reduce(
    (acc, i) => ({ loans: acc.loans + i.loans, balance: acc.balance + i.totalBalance }),
    { loans: 0, balance: 0 }
  );
  return ok(res, { items: pageRows, totals }, 'Outstanding loans', pagination);
});

// Derived EMI schedule (server-side only, never persisted) — one row per EMI 1..totalEmis.
// Due months run from the month AFTER disbursedAt; the last EMI carries the remainder.
// A row is 'paid' when a ledger entry exists for its seq, OR (legacy loans whose counters
// were incremented by payroll before the ledger existed) when seq <= paidEmis — those
// synthetic rows show method 'payroll' with paidAt null.
const buildSchedule = (loan) => {
  if (!loan.disbursedAt || !loan.totalEmis || !loan.emiAmount) return [];
  const bySeq = new Map((loan.payments || []).map((p) => [p.seq, p]));
  const firstDue = dayjs(loan.disbursedAt).add(1, 'month');
  const lastAmount = Math.max(round2(loan.amount - loan.emiAmount * (loan.totalEmis - 1)), 0);
  const rows = [];
  for (let seq = 1; seq <= loan.totalEmis; seq += 1) {
    const payment = bySeq.get(seq);
    const paid = Boolean(payment) || seq <= (loan.paidEmis || 0);
    const row = {
      seq,
      dueLabel: firstDue.add(seq - 1, 'month').format('MMM YYYY'),
      amount: seq === loan.totalEmis ? lastAmount : loan.emiAmount,
      status: paid ? 'paid' : 'pending',
    };
    if (paid) {
      row.paidAt = payment ? payment.paidAt : null; // null ⇒ synthetic legacy row
      row.method = payment ? payment.method : 'payroll';
      row.payrollMonth = payment && payment.month && payment.year
        ? dayjs(`${payment.year}-${String(payment.month).padStart(2, '0')}-01`).format('MMM YYYY')
        : null;
    }
    rows.push(row);
  }
  return rows;
};

const loanDetailShape = (loan) => ({ ...loan, schedule: buildSchedule(loan) });

// GET /loans/:id — data: { loan } incl. payments[] + derived schedule[]
const getLoan = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId };
  if (!canAdminister(req.user.role) && req.user.role !== ROLES.MANAGER) {
    filter.employeeId = req.user.employeeId;
  }
  const loan = await Loan.findOne(filter).populate(POPULATE).lean();
  if (!loan) throw new ApiError(404, 'Loan not found');
  return ok(res, { loan: loanDetailShape(loan) }, 'Loan detail');
});

const loadLoan = async (req, expectedStatus) => {
  const companyId = getCompanyId(req);
  const loan = await Loan.findOne({ _id: req.params.id, companyId }).populate('employeeId', 'userId');
  if (!loan) throw new ApiError(404, 'Loan not found');
  if (!expectedStatus.includes(loan.status)) {
    throw new ApiError(400, `Loan is '${loan.status}', expected one of: ${expectedStatus.join(', ')}`);
  }
  return loan;
};

const notifyEmployee = async (companyId, loan, title, message) => {
  if (loan.employeeId && loan.employeeId.userId) {
    await notify({
      companyId,
      userId: loan.employeeId.userId,
      title,
      message,
      type: 'loan',
      meta: { loanId: loan._id },
    });
  }
};

// PATCH /loans/:id/approve { emiAmount, totalEmis }
const approveLoan = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const emiAmount = Number(req.body.emiAmount);
  const totalEmis = Number(req.body.totalEmis);
  if (!emiAmount || emiAmount <= 0 || !totalEmis || totalEmis <= 0) {
    throw new ApiError(400, 'emiAmount and totalEmis (both > 0) are required to approve a loan');
  }
  const loan = await loadLoan(req, ['requested']);
  // the plan must cover the principal — an undershoot would balloon the last
  // schedule row beyond what either payment path can ever post against it
  const planTotal = round2(emiAmount * totalEmis);
  if (planTotal < loan.amount) {
    throw new ApiError(400,
      `EMI plan (₹${emiAmount} × ${totalEmis} = ₹${planTotal}) must cover the requested amount of ₹${loan.amount}`);
  }
  loan.status = 'approved';
  loan.emiAmount = emiAmount;
  loan.totalEmis = totalEmis;
  loan.approvedBy = req.user.userId;
  loan.approvedAt = new Date();
  await loan.save();
  await notifyEmployee(companyId, loan, 'Loan approved',
    `Your ${loan.type} request of ₹${loan.amount} has been approved (EMI ₹${emiAmount} × ${totalEmis}).`);
  logAudit(req, { action: 'loan.approve', entityType: 'Loan', entityId: loan._id, meta: { emiAmount, totalEmis } });
  return ok(res, loan, 'Loan approved');
});

// PATCH /loans/:id/reject { reason }
const rejectLoan = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const loan = await loadLoan(req, ['requested']);
  loan.status = 'rejected';
  loan.rejectReason = req.body.reason || null;
  await loan.save();
  await notifyEmployee(companyId, loan, 'Loan rejected',
    `Your ${loan.type} request of ₹${loan.amount} was rejected${req.body.reason ? `: ${req.body.reason}` : '.'}`);
  logAudit(req, { action: 'loan.reject', entityType: 'Loan', entityId: loan._id, meta: { reason: req.body.reason } });
  return ok(res, loan, 'Loan rejected');
});

// PATCH /loans/:id/disburse — balance initialized = amount
const disburseLoan = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const loan = await loadLoan(req, ['approved']);
  loan.status = 'disbursed';
  loan.disbursedAt = new Date();
  loan.balance = loan.amount;
  loan.paidEmis = 0;
  await loan.save();
  await notifyEmployee(companyId, loan, 'Loan disbursed',
    `Your ${loan.type} of ₹${loan.amount} has been disbursed. EMI of ₹${loan.emiAmount} will be deducted from your salary.`);
  logAudit(req, { action: 'loan.disburse', entityType: 'Loan', entityId: loan._id, meta: { amount: loan.amount } });
  return ok(res, loan, 'Loan disbursed');
});

// POST /loans/:id/payments — record an EMI payment received outside payroll (cash/UPI/…)
const recordPayment = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { method } = req.body;
  if (!method || !LOAN_PAYMENT_METHODS.includes(method)) {
    throw new ApiError(400, `method must be one of: ${LOAN_PAYMENT_METHODS.join(', ')}`);
  }
  let paidAt = new Date();
  if (req.body.paidAt != null) {
    paidAt = new Date(req.body.paidAt);
    if (Number.isNaN(paidAt.getTime())) throw new ApiError(400, 'paidAt must be a valid date');
  }
  const loan = await loadLoan(req, ['disbursed']); // non-disbursed (incl. closed) → 400
  const amount = req.body.amount != null
    ? round2(req.body.amount)
    : Math.min(loan.emiAmount || 0, loan.balance);
  if (!amount || amount <= 0) throw new ApiError(400, 'amount must be greater than 0');
  if (amount > loan.balance) throw new ApiError(400, `amount exceeds the outstanding balance (₹${loan.balance})`);

  // conditional atomic post — a concurrent writer (double submit, or payroll
  // mark-paid racing this request) invalidates the snapshot and yields a 409
  // instead of a duplicated seq / lost balance decrement
  const updated = await postLoanPayment(loan, {
    amount,
    method,
    paidAt,
    note: req.body.note || null,
    recordedBy: req.user.userId,
  });
  if (!updated) {
    throw new ApiError(409, 'This loan was updated by another operation — refresh and try again');
  }

  await notifyEmployee(companyId, loan, 'Loan payment recorded',
    `An EMI payment of ₹${amount} (${method.replace(/_/g, ' ')}) was recorded against your ${loan.type}.`
    + (updated.status === 'closed' ? ' Your loan is now fully repaid and closed.' : ` Outstanding balance: ₹${updated.balance}.`));

  const fresh = await Loan.findById(loan._id).populate(POPULATE).lean();
  return created(res, { loan: loanDetailShape(fresh) }, 'Payment recorded');
});

// PATCH /loans/:id/close — manual closure (e.g. settled outside payroll)
const closeLoan = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const loan = await loadLoan(req, ['disbursed']);
  loan.status = 'closed';
  loan.balance = 0;
  loan.closedAt = new Date();
  await loan.save();
  await notifyEmployee(companyId, loan, 'Loan closed', `Your ${loan.type} of ₹${loan.amount} has been closed.`);
  logAudit(req, { action: 'loan.close', entityType: 'Loan', entityId: loan._id });
  return ok(res, loan, 'Loan closed');
});

module.exports = { requestLoan, listLoans, outstanding, getLoan, approveLoan, rejectLoan, disburseLoan, recordPayment, closeLoan };
