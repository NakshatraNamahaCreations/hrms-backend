const dayjs = require('dayjs');
const mongoose = require('mongoose');
const Payroll = require('../models/Payroll');
const Payslip = require('../models/Payslip');
const Loan = require('../models/Loan');
const Employee = require('../models/Employee');
const Company = require('../models/Company');
const Attendance = require('../models/Attendance');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { logAudit } = require('../middleware/audit');
const payrollService = require('../services/payroll.service');
const { postLoanPayment } = require('../services/loan.service');
const { payslipTemplate, form16Template } = require('../utils/letterTemplates');
const { notify, sendEmail } = require('../services/notification.service');
const { ROLES } = require('../constants');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const POPULATE = [
  {
    path: 'employeeId',
    select: 'employeeCode personal.firstName personal.lastName userId job.departmentId job.designationId bank',
    populate: [
      { path: 'job.departmentId', select: 'name' },
      { path: 'job.designationId', select: 'name' },
    ],
  },
];

const parseMonthYear = (req, source = 'body') => {
  const src = source === 'body' ? req.body : req.query;
  let rawMonth = src.month;
  let rawYear = src.year;
  // accept combined "YYYY-MM" (admin panel month picker)
  if (typeof rawMonth === 'string' && /^\d{4}-\d{2}$/.test(rawMonth)) {
    rawYear = rawMonth.slice(0, 4);
    rawMonth = rawMonth.slice(5);
  }
  const month = Number(rawMonth);
  const year = Number(rawYear);
  if (!month || month < 1 || month > 12 || !year || year < 2000) {
    throw new ApiError(400, 'Valid month (1-12) and year are required');
  }
  return { month, year };
};

// POST /payroll/generate { month, year }
const generate = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { month, year } = parseMonthYear(req);
  if (await payrollService.isMonthLocked(companyId, month, year)) {
    throw new ApiError(423, `Payroll for ${month}/${year} is locked`);
  }
  const company = await Company.findById(companyId).lean();
  if (!company) throw new ApiError(404, 'Company not found');

  const employees = await Employee.find({ companyId, isDeleted: false, status: 'active' }).lean();
  if (!employees.length) throw new ApiError(400, 'No active employees to generate payroll for');

  const results = { generated: 0, skipped: 0, errors: [] };
  for (const employee of employees) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await Payroll.findOne({ companyId, employeeId: employee._id, month, year });
    if (existing && ['approved', 'paid', 'locked'].includes(existing.status)) {
      results.skipped += 1;
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const calc = await payrollService.calculateForEmployee({ company, employee, month, year });
      // eslint-disable-next-line no-await-in-loop
      await Payroll.findOneAndUpdate(
        { companyId, employeeId: employee._id, month, year },
        { $set: { ...calc, status: 'draft', generatedBy: req.user.userId } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      results.generated += 1;
    } catch (e) {
      results.errors.push({ employeeId: employee._id, error: e.message });
    }
  }

  logAudit(req, { action: 'payroll.generate', entityType: 'Payroll', meta: { month, year, ...results } });
  return created(res, { month, year, ...results }, `Payroll generated for ${results.generated} employee(s)`);
});

// GET /payroll?month&year&status — review list
const list = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
    filter.status = { $in: ['paid', 'locked'] }; // employees see finalized payslips only
  }
  if (req.query.month) filter.month = Number(req.query.month);
  if (req.query.year) filter.year = Number(req.query.year);
  if (req.query.status && !filter.status) filter.status = req.query.status;
  if (req.query.employeeId && !filter.employeeId) filter.employeeId = req.query.employeeId;

  const { items, pagination, finalFilter } = await paginate(req.query, Payroll, filter, {
    searchFields: ['status'],
    sortable: ['createdAt', 'updatedAt', 'month', 'year', 'status', 'netSalary'],
    populate: POPULATE,
  });

  // totals must cover the SAME set as the items (incl. ?search) — reuse the
  // exact filter paginate queried with, with ids cast for the aggregation.
  const matchFilter = { ...finalFilter, companyId: new mongoose.Types.ObjectId(String(filter.companyId)) };
  if (matchFilter.employeeId) matchFilter.employeeId = new mongoose.Types.ObjectId(String(matchFilter.employeeId));
  const totals = await Payroll.aggregate([
    { $match: matchFilter },
    { $group: { _id: null, gross: { $sum: '$earnings.gross' }, net: { $sum: '$netSalary' }, count: { $sum: 1 } } },
  ]).catch(() => []);

  return ok(res, { items, totals: totals[0] || { gross: 0, net: 0, count: 0 } }, 'Payroll list', pagination);
});

// GET /payroll/preview?month&year — compute payroll without persisting (admin run wizard)
const preview = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { month, year } = parseMonthYear(req, 'query');
  const company = await Company.findById(companyId).lean();
  if (!company) throw new ApiError(404, 'Company not found');
  const employees = await Employee.find({ companyId, isDeleted: false, status: 'active' }).lean();

  const rows = [];
  for (const employee of employees) {
    const name = `${employee.personal.firstName} ${employee.personal.lastName || ''}`.trim();
    try {
      // eslint-disable-next-line no-await-in-loop
      const calc = await payrollService.calculateForEmployee({ company, employee, month, year });
      rows.push({
        employeeId: employee._id,
        employeeCode: employee.employeeCode,
        name,
        employeeType: employee.job ? employee.job.employeeType : null,
        payableDays: calc.payableDays,
        lopDays: calc.lopDays,
        gross: calc.earnings.gross,
        deductions: calc.deductions.total,
        net: calc.netSalary,
      });
    } catch (e) {
      rows.push({ employeeId: employee._id, employeeCode: employee.employeeCode, name, error: e.message });
    }
  }
  return ok(res, rows, 'Payroll preview');
});

// GET /payroll/:id — single payroll item
const getOne = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
    filter.status = { $in: ['paid', 'locked'] };
  }
  const payroll = await Payroll.findOne(filter).populate(POPULATE).lean();
  if (!payroll) throw new ApiError(404, 'Payroll item not found');
  return ok(res, payroll, 'Payroll detail');
});

// POST /payroll/:id/lock — lock a single approved/paid payroll item
const lockOne = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const payroll = await Payroll.findOne({ _id: req.params.id, companyId });
  if (!payroll) throw new ApiError(404, 'Payroll item not found');
  if (!['approved', 'paid'].includes(payroll.status)) {
    throw new ApiError(400, `Payroll is '${payroll.status}' — only approved/paid items can be locked`);
  }
  payroll.status = 'locked';
  payroll.lockedAt = new Date();
  await payroll.save();
  logAudit(req, { action: 'payroll.lock', entityType: 'Payroll', entityId: payroll._id, meta: { month: payroll.month, year: payroll.year } });
  return ok(res, payroll, 'Payroll item locked');
});

// PATCH /payroll/:id/approve
const approve = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const payroll = await Payroll.findOne({ _id: req.params.id, companyId });
  if (!payroll) throw new ApiError(404, 'Payroll item not found');
  if (!['draft', 'under_review'].includes(payroll.status)) {
    throw new ApiError(400, `Payroll is '${payroll.status}' and cannot be approved`);
  }
  payroll.status = 'approved';
  payroll.approvedBy = req.user.userId;
  payroll.approvedAt = new Date();
  await payroll.save();
  logAudit(req, { action: 'payroll.approve', entityType: 'Payroll', entityId: payroll._id, meta: { month: payroll.month, year: payroll.year, netSalary: payroll.netSalary } });
  return ok(res, payroll, 'Payroll approved');
});

// Posts the deducted loan EMIs after a payroll item is paid — idempotent via loanEmisPosted.
// Returns the total actually posted (null when a previous run already posted).
const postLoanEmis = async (companyId, payroll) => {
  if (payroll.loanEmisPosted) return null;
  let posted = 0;
  if (payroll.deductions && payroll.deductions.loanEmi > 0) {
    const employeeId = payroll.employeeId._id || payroll.employeeId;
    const loans = await Loan.find({ companyId, employeeId, status: 'disbursed', balance: { $gt: 0 } });
    for (const loan of loans) {
      // EMI ledger entry (v1.6) — posted conditionally on the snapshot so a
      // concurrent manual POST /loans/:id/payments can never duplicate a seq
      // or lose a balance decrement; on conflict re-read and retry
      let current = loan;
      for (let attempt = 0; current && attempt < 3; attempt += 1) {
        const emi = Math.min(current.emiAmount || 0, current.balance);
        if (emi <= 0) break;
        // eslint-disable-next-line no-await-in-loop
        const updated = await postLoanPayment(current, {
          amount: emi,
          method: 'payroll',
          paidAt: new Date(),
          month: payroll.month,
          year: payroll.year,
          payrollId: payroll._id,
        });
        if (updated) {
          posted = round2(posted + emi);
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        current = await Loan.findOne({ _id: loan._id, status: 'disbursed', balance: { $gt: 0 } });
      }
    }
  }
  payroll.loanEmisPosted = true;
  await payroll.save();
  return posted;
};

// PATCH /payroll/:id/mark-paid — also emails the payslip to the employee
const markPaid = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const payroll = await Payroll.findOne({ _id: req.params.id, companyId }).populate('employeeId', 'userId personal.firstName personal.email');
  if (!payroll) throw new ApiError(404, 'Payroll item not found');
  if (payroll.status !== 'approved') throw new ApiError(400, `Payroll is '${payroll.status}', expected 'approved'`);
  payroll.status = 'paid';
  payroll.paidAt = new Date();
  await payroll.save();

  const postedEmi = await postLoanEmis(companyId, payroll);
  // deductions.loanEmi was frozen at generate time; manual loan payments or
  // disbursals in the generate→mark-paid window change what actually posts —
  // leave an audit trail of the divergence for reconciliation
  const deductedEmi = round2((payroll.deductions && payroll.deductions.loanEmi) || 0);
  if (postedEmi != null && round2(postedEmi) !== deductedEmi) {
    logAudit(req, {
      action: 'payroll.loan_emi_mismatch',
      entityType: 'Payroll',
      entityId: payroll._id,
      meta: { month: payroll.month, year: payroll.year, deductedFromSalary: deductedEmi, postedToLoans: round2(postedEmi) },
    });
  }
  await emailPayslipForItem(companyId, payroll); // stamps payslipEmailedAt

  if (payroll.employeeId && payroll.employeeId.userId) {
    await notify({
      companyId,
      userId: payroll.employeeId.userId,
      title: 'Salary credited',
      message: `Your salary for ${dayjs(`${payroll.year}-${String(payroll.month).padStart(2, '0')}-01`).format('MMMM YYYY')} (₹${payroll.netSalary}) has been processed.`,
      type: 'payroll',
    });
  }
  return ok(res, payroll, 'Payroll marked as paid');
});

// POST /payroll/lock { month, year } — locks payroll + attendance edits for the month
const lock = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { month, year } = parseMonthYear(req);
  const result = await Payroll.updateMany(
    { companyId, month, year, status: { $in: ['approved', 'paid'] } },
    { $set: { status: 'locked', lockedAt: new Date() } }
  );
  if (!result.modifiedCount) {
    throw new ApiError(400, 'No approved/paid payroll items to lock for this month. Approve payroll first.');
  }
  const monthStr = String(month).padStart(2, '0');
  await Attendance.updateMany(
    { companyId, date: { $regex: `^${year}-${monthStr}` } },
    { $set: { isLocked: true } }
  );
  logAudit(req, { action: 'payroll.lock', entityType: 'Payroll', meta: { month, year, locked: result.modifiedCount } });
  return ok(res, { month, year, locked: result.modifiedCount }, `Payroll locked for ${month}/${year}`);
});

// Builds payslip data (and persists a Payslip snapshot)
const buildPayslip = async (companyId, employeeId, month, year) => {
  const payroll = await Payroll.findOne({ companyId, employeeId, month, year }).populate(POPULATE).lean();
  if (!payroll) throw new ApiError(404, 'Payroll not found for this employee/month');
  const [company, employee] = await Promise.all([
    Company.findById(companyId).lean(),
    Employee.findById(employeeId).populate('job.departmentId job.designationId').lean(),
  ]);
  if (!employee) throw new ApiError(404, 'Employee not found');

  const payslipNumber = `PS-${year}${String(month).padStart(2, '0')}-${employee.employeeCode}`;
  await Payslip.findOneAndUpdate(
    { companyId, employeeId, month, year },
    {
      $set: {
        payrollId: payroll._id,
        payslipNumber,
        data: { payroll, employeeCode: employee.employeeCode },
        generatedAt: new Date(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
  return {
    company,
    employee,
    payroll,
    payslipNumber,
    designation: employee.job.designationId ? employee.job.designationId.name : null,
    department: employee.job.departmentId ? employee.job.departmentId.name : null,
  };
};

const payslipResponse = (data) => ({
  payslipNumber: data.payslipNumber,
  company: { name: data.company.name, address: data.company.address, logo: data.company.logo },
  employee: {
    _id: data.employee._id,
    employeeCode: data.employee.employeeCode,
    name: `${data.employee.personal.firstName} ${data.employee.personal.lastName || ''}`.trim(),
    designation: data.designation,
    department: data.department,
    bank: data.employee.bank,
  },
  payroll: data.payroll,
});

// Emails the rendered HTML payslip to the employee's personal email and stamps
// payslipEmailedAt (idempotent). Returns true when an email went out.
const emailPayslipForItem = async (companyId, payroll) => {
  if (payroll.payslipEmailedAt) return false;
  const employeeId = payroll.employeeId._id || payroll.employeeId;
  const data = await buildPayslip(companyId, employeeId, payroll.month, payroll.year);
  const to = data.employee.personal && data.employee.personal.email;
  if (!to) return false;
  const monthName = dayjs(`${payroll.year}-${String(payroll.month).padStart(2, '0')}-01`).format('MMMM YYYY');
  const html = payslipTemplate({
    company: data.company,
    employee: data.employee,
    payroll: data.payroll,
    designation: data.designation,
    department: data.department,
  });
  await sendEmail({ to, subject: `Payslip ${monthName} — ${data.company.name}`, html });
  payroll.payslipEmailedAt = new Date();
  await payroll.save();
  return true;
};

// Emails every paid-but-not-yet-emailed payslip of a month. Shared by the
// POST /payroll/email-payslips route and the monthly cron in server.js.
const emailPayslipsForMonth = async (companyId, month, year) => {
  const items = await Payroll.find({
    companyId,
    month: Number(month),
    year: Number(year),
    status: { $in: ['paid', 'locked'] },
    paidAt: { $ne: null },
  }).populate('employeeId', 'userId personal.firstName personal.email');

  let sent = 0;
  let skipped = 0;
  for (const payroll of items) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const emailed = await emailPayslipForItem(companyId, payroll);
      if (emailed) sent += 1;
      else skipped += 1;
    } catch (e) {
      skipped += 1;
    }
  }
  return { sent, skipped };
};

// POST /payroll/email-payslips { month, year } — bulk send for the month
const emailPayslips = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { month, year } = parseMonthYear(req);
  const result = await emailPayslipsForMonth(companyId, month, year);
  logAudit(req, { action: 'payroll.email_payslips', entityType: 'Payroll', meta: { month, year, ...result } });
  return ok(res, { month, year, ...result }, `Payslips emailed: ${result.sent} sent, ${result.skipped} skipped`);
});

// GET /payroll/form16?employeeId&fy=2026&format=html — basic Form 16 Part B.
// fy is the financial-year START (Apr fy → Mar fy+1); aggregates paid/locked items.
const form16 = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  let employeeId = req.query.employeeId;
  if (![ROLES.PAYROLL_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN].includes(req.user.role)) {
    employeeId = req.user.employeeId; // non payroll-admins always get their own statement
  }
  if (!employeeId) throw new ApiError(400, 'employeeId is required');
  const now = dayjs();
  const fy = Number(req.query.fy) || (now.month() + 1 >= 4 ? now.year() : now.year() - 1);

  const [company, employee] = await Promise.all([
    Company.findById(companyId).lean(),
    Employee.findOne({ _id: employeeId, companyId }).populate('job.designationId', 'name').lean(),
  ]);
  if (!employee) throw new ApiError(404, 'Employee not found');

  const items = await Payroll.find({
    companyId,
    employeeId,
    status: { $in: ['paid', 'locked'] },
    paidAt: { $ne: null },
    $or: [
      { year: fy, month: { $gte: 4 } },
      { year: fy + 1, month: { $lte: 3 } },
    ],
  }).sort({ year: 1, month: 1 }).lean();

  const sum = (pick) => round2(items.reduce((acc, p) => acc + (pick(p) || 0), 0));
  const gross = sum((p) => p.earnings && p.earnings.gross);
  const basic = sum((p) => p.earnings && p.earnings.basic);
  const hra = sum((p) => p.earnings && p.earnings.hra);
  const data = {
    employee: {
      _id: employee._id,
      employeeCode: employee.employeeCode,
      name: `${employee.personal.firstName} ${employee.personal.lastName || ''}`.trim(),
      designation: employee.job.designationId ? employee.job.designationId.name : null,
    },
    fy,
    months: items.length,
    gross,
    basic,
    hra,
    otherAllowances: round2(gross - basic - hra),
    deductions: {
      pf: sum((p) => p.deductions && p.deductions.pf),
      esi: sum((p) => p.deductions && p.deductions.esi),
      professionalTax: sum((p) => p.deductions && p.deductions.professionalTax),
      tds: sum((p) => p.deductions && p.deductions.tds),
    },
    netTotal: sum((p) => p.netSalary),
  };

  if (req.query.format === 'html') {
    const html = form16Template({ ...data, company, employee, designation: data.employee.designation });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }
  return ok(res, data, 'Form 16 data');
});

// GET /payroll/payslip?employeeId&month&year — JSON payslip data
const payslipData = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { month, year } = parseMonthYear(req, 'query');
  let employeeId = req.query.employeeId;
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) employeeId = req.user.employeeId;
  if (!employeeId) throw new ApiError(400, 'employeeId is required');

  const data = await buildPayslip(companyId, employeeId, month, year);
  return ok(res, payslipResponse(data), 'Payslip data');
});

// GET /payroll/payslips/:id — payslip data addressed by payroll item id (mobile)
const payslipById = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
    filter.status = { $in: ['paid', 'locked'] };
  }
  const payroll = await Payroll.findOne(filter).lean();
  if (!payroll) throw new ApiError(404, 'Payslip not found');
  const data = await buildPayslip(companyId, payroll.employeeId, payroll.month, payroll.year);
  return ok(res, payslipResponse(data), 'Payslip data');
});

// GET /payroll/payslip/html?employeeId&month&year — rendered HTML (PDF-ready)
const payslipHtml = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { month, year } = parseMonthYear(req, 'query');
  let employeeId = req.query.employeeId;
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) employeeId = req.user.employeeId;
  if (!employeeId) throw new ApiError(400, 'employeeId is required');

  const data = await buildPayslip(companyId, employeeId, month, year);
  const html = payslipTemplate({
    company: data.company,
    employee: data.employee,
    payroll: data.payroll,
    designation: data.designation,
    department: data.department,
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

module.exports = {
  generate,
  list,
  preview,
  getOne,
  approve,
  markPaid,
  lock,
  lockOne,
  payslipData,
  payslipById,
  payslipHtml,
  emailPayslips,
  emailPayslipsForMonth,
  form16,
};

