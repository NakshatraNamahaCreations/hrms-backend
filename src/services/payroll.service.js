const dayjs = require('dayjs');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');
const Holiday = require('../models/Holiday');
const FieldVisit = require('../models/FieldVisit');
const FieldLocationLog = require('../models/FieldLocationLog');
const Loan = require('../models/Loan');
const { haversineMeters } = require('../utils/geo');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Counts week-off dates of the month per company settings (days 0-6, 0 = Sunday).
 */
const countWeekOffs = (year, month, weekOffDays = [0]) => {
  const daysInMonth = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).daysInMonth();
  let count = 0;
  const dates = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = dayjs(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    if (weekOffDays.includes(date.day())) {
      count += 1;
      dates.push(date.format('YYYY-MM-DD'));
    }
  }
  return { count, dates };
};

/**
 * Approved PAID leave days of the employee that fall inside the month.
 */
const countPaidLeaveDays = async (companyId, employeeId, year, month) => {
  const monthStart = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
  const monthEnd = monthStart.endOf('month');
  const leaves = await Leave.find({
    companyId,
    employeeId,
    status: 'approved',
    leaveType: { $ne: 'unpaid' },
    fromDate: { $lte: monthEnd.format('YYYY-MM-DD') },
    toDate: { $gte: monthStart.format('YYYY-MM-DD') },
  }).lean();

  let days = 0;
  for (const leave of leaves) {
    let cur = dayjs(leave.fromDate);
    const end = dayjs(leave.toDate);
    while (cur.isBefore(end) || cur.isSame(end, 'day')) {
      if (cur.month() + 1 === month && cur.year() === year) {
        days += leave.halfDay ? 0.5 : 1;
      }
      cur = cur.add(1, 'day');
    }
  }
  return days;
};

/**
 * Total travel distance (km) for the month from interval location logs.
 */
const computeTravelKm = async (companyId, employeeId, year, month) => {
  const monthStart = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).startOf('day');
  const monthEnd = monthStart.endOf('month');
  const logs = await FieldLocationLog.find({
    companyId,
    employeeId,
    capturedAt: { $gte: monthStart.toDate(), $lte: monthEnd.toDate() },
  })
    .sort({ capturedAt: 1 })
    .select('latitude longitude capturedAt')
    .lean();

  let meters = 0;
  for (let i = 1; i < logs.length; i += 1) {
    const prev = logs[i - 1];
    const cur = logs[i];
    // ignore jumps across days
    if (dayjs(cur.capturedAt).isSame(dayjs(prev.capturedAt), 'day')) {
      meters += haversineMeters(prev.latitude, prev.longitude, cur.latitude, cur.longitude);
    }
  }
  return round2(meters / 1000);
};

/**
 * Full salary calculation for one employee for one month.
 * Returns a plain object matching the Payroll schema fields.
 */
const calculateForEmployee = async ({ company, employee, month, year }) => {
  const companyId = company._id;
  const employeeId = employee._id;
  const monthStr = String(month).padStart(2, '0');
  const monthStart = dayjs(`${year}-${monthStr}-01`);
  const totalDays = monthStart.daysInMonth();
  const payrollSettings = (company.settings && company.settings.payroll) || {};
  const weekOffDays = (company.settings && company.settings.weekOffDays) || [0];

  // --- attendance buckets ---------------------------------------------------
  const attendance = await Attendance.find({
    companyId,
    employeeId,
    date: { $gte: `${year}-${monthStr}-01`, $lte: `${year}-${monthStr}-${String(totalDays).padStart(2, '0')}` },
  }).lean();

  let presentDays = 0;
  let halfDays = 0;
  const presentDates = new Set();
  for (const a of attendance) {
    if (['present', 'late', 'early_exit', 'wfh'].includes(a.status)) {
      presentDays += 1;
      presentDates.add(a.date);
    } else if (a.status === 'half_day') {
      halfDays += 1;
      presentDates.add(a.date);
    }
  }

  const paidLeaveDays = await countPaidLeaveDays(companyId, employeeId, year, month);

  const holidays = await Holiday.find({
    companyId,
    isDeleted: false,
    date: { $regex: `^${year}-${monthStr}` },
  }).lean();
  const holidayDates = holidays.map((h) => h.date).filter((d) => !presentDates.has(d));

  const weekOffs = countWeekOffs(year, month, weekOffDays);
  const weekOffCount = weekOffs.dates.filter((d) => !presentDates.has(d) && !holidayDates.includes(d)).length;

  let payableDays = presentDays + halfDays * 0.5 + paidLeaveDays + holidayDates.length + weekOffCount;
  payableDays = Math.min(payableDays, totalDays);
  const lopDays = round2(Math.max(totalDays - payableDays, 0));
  payableDays = round2(payableDays);

  // --- field metrics ---------------------------------------------------------
  const isField = employee.job && employee.job.employeeType === 'field_employee';
  let fieldDays = 0;
  let travelKm = 0;
  if (isField) {
    const visitDates = await FieldVisit.distinct('date', {
      companyId,
      employeeId,
      date: { $regex: `^${year}-${monthStr}` },
      checkInTime: { $ne: null },
    });
    fieldDays = visitDates.length;
    travelKm = await computeTravelKm(companyId, employeeId, year, month);
  }

  // --- earnings (prorated by payable days) ------------------------------------
  const sal = employee.salary || {};
  const ratio = totalDays > 0 ? payableDays / totalDays : 0;
  const basic = round2((sal.basic || 0) * ratio);
  const hra = round2((sal.hra || 0) * ratio);
  const conveyance = round2((sal.conveyance || 0) * ratio);
  const medicalAllowance = round2((sal.medicalAllowance || 0) * ratio);
  const specialAllowance = round2((sal.specialAllowance || 0) * ratio);
  const otherAllowances = round2((sal.otherAllowances || 0) * ratio);

  const perDayFieldAllowance =
    (employee.field && employee.field.fieldAllowancePerDay) || payrollSettings.fieldAllowancePerDay || 0;
  const perKmRate =
    (employee.field && employee.field.travelAllowancePerKm) || payrollSettings.travelAllowancePerKm || 0;
  const fieldAllowance = isField ? round2(fieldDays * perDayFieldAllowance) : 0;
  const travelAllowance = isField ? round2(travelKm * perKmRate) : 0;

  const gross = round2(
    basic + hra + conveyance + medicalAllowance + specialAllowance + otherAllowances + fieldAllowance + travelAllowance
  );

  // --- deductions --------------------------------------------------------------
  const fullMonthGross = round2(
    (sal.basic || 0) + (sal.hra || 0) + (sal.conveyance || 0) + (sal.medicalAllowance || 0) +
    (sal.specialAllowance || 0) + (sal.otherAllowances || 0)
  );
  const perDayGross = totalDays > 0 ? fullMonthGross / totalDays : 0;
  const lopAmount = round2(perDayGross * lopDays);

  const pf = sal.pfApplicable ? round2((basic * (payrollSettings.pfPercent || 12)) / 100) : 0;
  const esi =
    sal.esiApplicable && fullMonthGross <= (payrollSettings.esiWageLimit || 21000)
      ? round2((gross * (payrollSettings.esiPercent || 0.75)) / 100)
      : 0;
  const professionalTax =
    sal.ptApplicable && gross > (payrollSettings.ptWageThreshold || 15000)
      ? round2(payrollSettings.professionalTax || 200)
      : 0;
  const tds = sal.tdsPercent ? round2((gross * sal.tdsPercent) / 100) : 0;

  // active loan EMIs (capped at remaining balance per loan)
  const activeLoans = await Loan.find({ companyId, employeeId, status: 'disbursed', balance: { $gt: 0 } })
    .select('emiAmount balance')
    .lean();
  const loanEmi = round2(activeLoans.reduce((sum, loan) => sum + Math.min(loan.emiAmount || 0, loan.balance || 0), 0));

  const totalDeductions = round2(pf + esi + professionalTax + tds + loanEmi);
  const netSalary = round2(gross - totalDeductions);

  return {
    month,
    year,
    totalDays,
    presentDays,
    halfDays,
    paidLeaveDays,
    holidayDays: holidayDates.length,
    weekOffDays: weekOffCount,
    payableDays,
    lopDays,
    fieldDays,
    travelKm,
    earnings: {
      basic,
      hra,
      conveyance,
      medicalAllowance,
      specialAllowance,
      otherAllowances,
      fieldAllowance,
      travelAllowance,
      gross,
    },
    deductions: {
      pf,
      esi,
      professionalTax,
      tds,
      loanEmi,
      lopAmount,
      other: 0,
      total: totalDeductions,
    },
    netSalary,
  };
};

const isMonthLocked = async (companyId, month, year) => {
  const Payroll = require('../models/Payroll');
  const locked = await Payroll.exists({ companyId, month: Number(month), year: Number(year), status: 'locked' });
  return Boolean(locked);
};

module.exports = { calculateForEmployee, isMonthLocked, countWeekOffs, computeTravelKm };
