// Job profitability helpers.
//
// Daily cost is DERIVED FROM SALARY: monthly gross (annual CTC / 12) divided by
// the company's working-days-per-month (default 30, so ₹30,000/month → ₹1,000/day,
// which matches the product spec example). A company can tune the divisor via
// company.settings.payroll.workingDaysPerMonth.

const DEFAULT_WORKING_DAYS = 30;

function deriveDailyCost(employee, company) {
  const ctc = Number(employee && employee.salary && employee.salary.ctc) || 0;
  if (ctc <= 0) return 0;
  const workingDays =
    Number(company && company.settings && company.settings.payroll && company.settings.payroll.workingDaysPerMonth) ||
    DEFAULT_WORKING_DAYS;
  return Math.round(ctc / 12 / workingDays);
}

// Count distinct calendar days the employee actually worked the job, read from
// the assignment's status history (reached / checked_in / in_progress / completed
// / checked_out entries). Floor of 1 once the job has started.
const WORKING_STATUSES = ['reached', 'checked_in', 'in_progress', 'completed', 'checked_out'];

function countWorkDays(assignment) {
  const history = Array.isArray(assignment && assignment.statusHistory) ? assignment.statusHistory : [];
  const days = new Set();
  for (const h of history) {
    if (WORKING_STATUSES.includes(h.status) && h.at) {
      days.add(new Date(h.at).toISOString().slice(0, 10)); // YYYY-MM-DD
    }
  }
  const hasStarted = history.some((h) => WORKING_STATUSES.includes(h.status))
    || ['in_progress', 'completed', 'checked_out'].includes(assignment && assignment.status);
  return days.size || (hasStarted ? 1 : 0);
}

// jobValue − (dailyCost × daysWorked). All ₹, rounded.
function computeJobCosting({ jobValue = 0, dailyCost = 0, daysWorked = 0 }) {
  const value = Math.max(0, Number(jobValue) || 0);
  const cost = Math.round((Number(dailyCost) || 0) * (Number(daysWorked) || 0));
  const profit = Math.round(value - cost);
  const margin = value > 0 ? Math.round((profit / value) * 1000) / 10 : 0; // one decimal %
  return {
    dailyCost: Math.round(Number(dailyCost) || 0),
    daysWorked: Number(daysWorked) || 0,
    laborCost: cost,
    profit,
    margin,
    computedAt: new Date(),
  };
}

// Multi-member job costing. Each member's cost = their day-wise salary × days
// they worked; job profit = jobValue − total team cost; each member is then
// attributed a share of that profit proportional to their cost (sums to job
// profit). employeesById maps employeeId(string) -> employee doc (with salary).
function computeTeamCosting({ jobValue = 0, assignees = [], employeesById = {}, company }) {
  const value = Math.max(0, Number(jobValue) || 0);
  let totalCost = 0;
  const members = (assignees || []).map((a) => {
    const plain = a && a.toObject ? a.toObject() : { ...a };
    const key = String((plain.employeeId && (plain.employeeId._id || plain.employeeId)) || '');
    const emp = employeesById[key] || (plain.employeeId && plain.employeeId.salary ? plain.employeeId : null);
    const dailyCost = deriveDailyCost(emp, company);
    const days = plain.daysOverride != null ? plain.daysOverride : ((plain.workDays && plain.workDays.length) || 0);
    const cost = Math.round(dailyCost * days);
    totalCost += cost;
    return { ...plain, dailyCost, daysWorked: days, cost };
  });
  const profit = Math.round(value - totalCost);
  members.forEach((m) => {
    m.profit = totalCost > 0
      ? Math.round(profit * (m.cost / totalCost))
      : (members.length ? Math.round(profit / members.length) : 0);
  });
  const margin = value > 0 ? Math.round((profit / value) * 1000) / 10 : 0;
  return {
    jobValue: value,
    totalCost,
    profit,
    margin,
    daysTotal: members.reduce((s, m) => s + m.daysWorked, 0),
    members,
  };
}

module.exports = { deriveDailyCost, countWorkDays, computeJobCosting, computeTeamCosting, DEFAULT_WORKING_DAYS };
