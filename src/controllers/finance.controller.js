const dayjs = require('dayjs');
const Company = require('../models/Company');
const Employee = require('../models/Employee');
const FieldWorkAssignment = require('../models/FieldWorkAssignment');
const CompanyFinance = require('../models/CompanyFinance');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { deriveDailyCost, computeTeamCosting } = require('../utils/costing');

const r = (n) => Math.round(Number(n) || 0);

// Loads (or lazily creates) the company's finance settings doc.
const loadFinance = async (companyId) => {
  let finance = await CompanyFinance.findOne({ companyId });
  if (!finance) finance = await CompanyFinance.create({ companyId });
  return finance;
};

// Validates and clamps an editable finance number. Percents must be 0..100, all >= 0.
const num = (value, { percent = false, label } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${label} must be a number >= 0`);
  if (percent && n > 100) throw new ApiError(400, `${label} must be between 0 and 100`);
  return n;
};

// GET /finance/settings — the company's CompanyFinance (created with defaults if missing).
const getSettings = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const finance = await loadFinance(companyId);
  return ok(res, finance, 'Finance settings');
});

// PUT /finance/settings — upsert/update editable fields.
const updateSettings = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const finance = await loadFinance(companyId);
  const body = req.body || {};

  if (body.overheads && typeof body.overheads === 'object') {
    for (const key of ['electricity', 'internet', 'rent', 'software', 'other']) {
      if (body.overheads[key] != null) {
        finance.overheads[key] = num(body.overheads[key], { label: `overheads.${key}` });
      }
    }
  }
  if (body.taxPercent != null) {
    finance.taxPercent = num(body.taxPercent, { percent: true, label: 'taxPercent' });
  }
  if (body.safeDepositPercent != null) {
    finance.safeDepositPercent = num(body.safeDepositPercent, { percent: true, label: 'safeDepositPercent' });
  }
  if (body.savedAmount != null) {
    finance.savedAmount = num(body.savedAmount, { label: 'savedAmount' });
  }
  if (body.safetyFundMonths != null) {
    finance.safetyFundMonths = num(body.safetyFundMonths, { label: 'safetyFundMonths' });
  }
  if (body.targetMarginPercent != null) {
    finance.targetMarginPercent = num(body.targetMarginPercent, { percent: true, label: 'targetMarginPercent' });
  }

  await finance.save();
  return ok(res, finance, 'Finance settings updated');
});

const COMPLETED_STATUSES = ['completed', 'checked_out'];

// GET /finance/intelligence?month=YYYY-MM — aggregated MONTHLY-BASE numbers.
const getIntelligence = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : dayjs().format('YYYY-MM');

  const [company, finance, employees, jobs] = await Promise.all([
    Company.findById(companyId).select('settings').lean(),
    loadFinance(companyId),
    Employee.find({ companyId, isDeleted: false, status: 'active' })
      .select('salary employeeCode personal job')
      .lean(),
    FieldWorkAssignment.find({ companyId, isDeleted: false, date: new RegExp(`^${month}`) })
      .select('assignees jobValue status title date employeeId')
      .lean(),
  ]);

  const taxPercent = finance.taxPercent;
  const safeDepositPercent = finance.safeDepositPercent;
  const targetMarginPercent = finance.targetMarginPercent;
  const safetyFundMonths = finance.safetyFundMonths;
  const savedAmount = finance.savedAmount;
  const o = finance.overheads || {};
  const overheadBreakup = {
    electricity: r(o.electricity),
    internet: r(o.internet),
    rent: r(o.rent),
    software: r(o.software),
    other: r(o.other),
  };

  // employeesById: idString -> employee doc (for costing + name/role lookups)
  const employeesById = {};
  for (const emp of employees) employeesById[String(emp._id)] = emp;

  // --- Payroll (monthly) = Σ round(annual ctc / 12) ---------------------------
  let payroll = 0;
  for (const emp of employees) payroll += r((emp.salary && emp.salary.ctc) / 12);

  // --- Overheads --------------------------------------------------------------
  const overheads = overheadBreakup.electricity + overheadBreakup.internet
    + overheadBreakup.rent + overheadBreakup.software + overheadBreakup.other;

  // --- Revenue / project counts ----------------------------------------------
  let revenue = 0;
  const jobCount = jobs.length;
  let completed = 0;
  for (const job of jobs) {
    revenue += Number(job.jobValue) || 0;
    if (COMPLETED_STATUSES.includes(job.status)) completed += 1;
  }
  revenue = r(revenue);
  const avgProjectValue = jobCount ? r(revenue / jobCount) : 0;

  const totalCost = payroll + overheads;
  const profit = revenue - totalCost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  // --- Project economics ------------------------------------------------------
  const breakEvenProjects = avgProjectValue > 0 ? Math.ceil(totalCost / avgProjectValue) : 0;
  const profitProjects = avgProjectValue > 0
    ? Math.ceil((totalCost / (1 - targetMarginPercent / 100)) / avgProjectValue)
    : 0;
  const projects = jobs.map((job) => ({
    title: job.title,
    value: Number(job.jobValue) || 0,
    status: job.status,
    completed: COMPLETED_STATUSES.includes(job.status),
  }));

  // --- Per-employee profitability (company-wide for the month) ----------------
  const empAccum = {}; // idString -> { days, cost, profit, revenueShare, jobs, lastRole }
  for (const job of jobs) {
    // Effective assignees: synthesize from primary employeeId when none recorded.
    let assignees = Array.isArray(job.assignees) ? job.assignees : [];
    if (!assignees.length && job.employeeId) {
      assignees = [{ employeeId: job.employeeId, role: null, daysOverride: null, workDays: [] }];
    }
    if (!assignees.length) continue;

    const team = computeTeamCosting({
      jobValue: Number(job.jobValue) || 0,
      assignees,
      employeesById,
      company,
    });
    const jobTotalCost = team.totalCost;
    const jobValue = team.jobValue;

    for (const member of team.members) {
      const key = String((member.employeeId && (member.employeeId._id || member.employeeId)) || '');
      if (!key) continue;
      if (!empAccum[key]) {
        empAccum[key] = { days: 0, cost: 0, profit: 0, revenueShare: 0, jobs: 0, lastRole: null };
      }
      const acc = empAccum[key];
      acc.days += member.daysWorked;
      acc.cost += member.cost;
      acc.profit += member.profit;
      acc.revenueShare += jobTotalCost > 0 ? (jobValue * member.cost) / jobTotalCost : 0;
      acc.jobs += 1;
      acc.lastRole = member.role != null ? member.role : acc.lastRole;
    }
  }

  const employeesOut = Object.entries(empAccum).map(([key, acc]) => {
    const emp = employeesById[key];
    const first = emp && emp.personal ? emp.personal.firstName || '' : '';
    const last = emp && emp.personal ? emp.personal.lastName || '' : '';
    const revenueShare = r(acc.revenueShare);
    const empProfit = r(acc.profit);
    return {
      employeeId: key,
      employeeCode: emp ? emp.employeeCode : null,
      name: `${first} ${last}`.trim(),
      role: acc.lastRole,
      days: acc.days,
      cost: r(acc.cost),
      profit: empProfit,
      revenueShare,
      jobs: acc.jobs,
      profitPerDay: acc.days > 0 ? r(acc.profit / acc.days) : 0,
      margin: acc.revenueShare > 0 ? (acc.profit / acc.revenueShare) * 100 : 0,
      dailyCost: deriveDailyCost(emp, company),
    };
  }).sort((a, b) => b.profitPerDay - a.profitPerDay);

  // --- Savings ----------------------------------------------------------------
  const positiveProfit = Math.max(0, profit);
  const tax = r((positiveProfit * taxPercent) / 100);
  const safeDeposit = r((positiveProfit * safeDepositPercent) / 100);
  const free = profit - tax - safeDeposit;
  const safetyFundTarget = r(totalCost * safetyFundMonths);
  const saved = r(savedAmount);
  const fundedPercent = safetyFundTarget > 0 ? Math.min(100, r((saved / safetyFundTarget) * 100)) : 0;
  const monthsToTarget = safeDeposit > 0 ? Math.ceil(Math.max(0, safetyFundTarget - saved) / safeDeposit) : null;

  // --- Cost breakup -----------------------------------------------------------
  const costBreakupRaw = [
    { head: 'Labour (payroll)', amount: payroll },
    { head: 'Electricity', amount: overheadBreakup.electricity },
    { head: 'Internet', amount: overheadBreakup.internet },
    { head: 'Rent', amount: overheadBreakup.rent },
    { head: 'Software & tools', amount: overheadBreakup.software },
    { head: 'Other expenses', amount: overheadBreakup.other },
  ];
  const costBreakup = costBreakupRaw.map((row) => ({
    head: row.head,
    amount: row.amount,
    sharePercent: totalCost > 0 ? r((row.amount / totalCost) * 100) : 0,
  }));

  return ok(res, {
    month,
    revenue,
    payroll,
    overheads,
    overheadBreakup,
    totalCost,
    profit,
    margin,
    avgProjectValue,
    jobCount,
    completed,
    breakEvenProjects,
    profitProjects,
    projects,
    employees: employeesOut,
    savings: { tax, safeDeposit, free, safetyFundTarget, saved, fundedPercent, monthsToTarget },
    costBreakup,
    settings: {
      taxPercent,
      safeDepositPercent,
      savedAmount,
      safetyFundMonths,
      targetMarginPercent,
      overheads: overheadBreakup,
    },
  }, 'Profit intelligence');
});

module.exports = { getSettings, updateSettings, getIntelligence };
