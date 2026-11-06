/* eslint-disable no-console */
// Idempotent seed script — upserts by email/name. Run: npm run seed
require('dotenv').config();
const dayjs = require('dayjs');
const connectDB = require('../src/config/db');

const {
  User,
  Company,
  SubscriptionPlan,
  CompanySubscription,
  Payment,
  Employee,
  Branch,
  Department,
  Designation,
  Shift,
  Holiday,
  Attendance,
  AttendanceCorrection,
  BiometricDevice,
  BiometricLog,
  Client,
  FieldWorkAssignment,
  FieldVisit,
  FieldLocationLog,
  FieldExpense,
  Leave,
  LeaveBalance,
  Loan,
  IncrementRequest,
  Payroll,
  RecruitmentJob,
  Candidate,
  PerformanceCycle,
  PerformanceReview,
  Task,
  Project,
  Timesheet,
  Policy,
  PolicyAck,
  Course,
  CourseAssignment,
  Asset,
  EmployeeDocument,
  Announcement,
  Ticket,
  Resignation,
  FeatureRequest,
  Notification,
} = require('../src/models');
const { FEATURE_KEYS, ROLES } = require('../src/constants');
const { calculateForEmployee } = require('../src/services/payroll.service');
const { upsertDayAttendance } = require('../src/services/fieldAttendance.service');

const today = () => dayjs().format('YYYY-MM-DD');

// nth previous non-Sunday day (n=1 → last working day before today)
const prevWorking = (n) => {
  let d = dayjs();
  let count = 0;
  while (count < n) {
    d = d.subtract(1, 'day');
    if (d.day() !== 0) count += 1;
  }
  return d;
};

// Upserts a user; always resets password so demo credentials stay valid.
const upsertUser = async ({ name, email, password, role, companyId = null, employeeId = null }) => {
  let user = await User.findOne({ email }).select('+password');
  if (!user) {
    user = new User({ name, email, password, role, companyId, employeeId });
  } else {
    user.name = name;
    user.password = password; // re-hashed by pre-save hook
    user.role = role;
    user.companyId = companyId;
    if (employeeId) user.employeeId = employeeId;
    user.isActive = true;
  }
  await user.save();
  return user;
};

const upsertEmployee = async (companyId, employeeCode, data) => {
  let employee = await Employee.findOne({ companyId, employeeCode });
  if (!employee) {
    employee = new Employee({ companyId, employeeCode, ...data });
  } else {
    Object.assign(employee, data);
  }
  employee.isDeleted = false; // demo employees must survive soft-deletes from testing
  await employee.save();
  return employee;
};

const upsertByName = async (Model, filter, data) => {
  let doc = await Model.findOne(filter);
  if (!doc) doc = new Model({ ...filter, ...data });
  else Object.assign(doc, data);
  await doc.save();
  return doc;
};

const seedPlans = async () => {
  const basicFeatures = [
    'employeeManagement', 'attendance', 'leave', 'holidays', 'documents', 'announcements', 'tickets',
  ];
  const standardFeatures = [
    ...basicFeatures,
    'payroll', 'shifts', 'tasks', 'recruitment', 'onboarding', 'assetManagement',
    'exitManagement', 'expenseManagement',
  ];
  // FEATURE_KEYS includes the v1.1 additions (loans) — both land
  // on Premium and Enterprise automatically.
  const premiumFeatures = FEATURE_KEYS.filter((k) => k !== 'whatsappNotification');
  const enterpriseFeatures = [...FEATURE_KEYS];

  const plans = [
    { name: 'Basic', description: 'Core HR essentials for small teams', monthlyPrice: 999, yearlyPrice: 9990, employeeLimit: 25, fieldEmployeeLimit: 0, enabledFeatures: basicFeatures, trialDays: 14 },
    { name: 'Standard', description: 'Full HR suite with payroll & recruitment', monthlyPrice: 2499, yearlyPrice: 24990, employeeLimit: 100, fieldEmployeeLimit: 10, enabledFeatures: standardFeatures, trialDays: 14 },
    { name: 'Premium', description: 'HR + complete field workforce management', monthlyPrice: 4999, yearlyPrice: 49990, employeeLimit: 500, fieldEmployeeLimit: 100, enabledFeatures: premiumFeatures, trialDays: 14 },
    { name: 'Enterprise', description: 'Everything, including WhatsApp notifications', monthlyPrice: 9999, yearlyPrice: 99990, employeeLimit: 5000, fieldEmployeeLimit: 2000, enabledFeatures: enterpriseFeatures, trialDays: 30 },
  ];
  const result = {};
  for (const plan of plans) {
    result[plan.name] = await upsertByName(SubscriptionPlan, { name: plan.name }, { ...plan, status: 'active' });
    console.log(`  ✔ Plan: ${plan.name}`);
  }
  return result;
};

const seedLeaveBalance = async (companyId, employeeId) => {
  await LeaveBalance.findOneAndUpdate(
    { companyId, employeeId, year: dayjs().year() },
    {
      $setOnInsert: {
        balances: {
          casual: { total: 12, used: 0 },
          sick: { total: 8, used: 0 },
          earned: { total: 15, used: 0 },
        },
      },
    },
    { upsert: true }
  );
};

const run = async () => {
  await connectDB();
  console.log('Seeding...');

  // 1. Super admin (platform owner)
  await upsertUser({
    name: 'Platform Owner',
    email: 'owner@hrms.com',
    password: 'Owner@123',
    role: ROLES.SUPER_ADMIN,
    companyId: null,
  });
  console.log('  ✔ Super admin: owner@hrms.com / Owner@123');

  // 2. Plans
  const plans = await seedPlans();

  // 3. Demo company "Acme Corp" on Premium (active)
  const acme = await upsertByName(Company, { code: 'ACME' }, {
    name: 'Acme Corp',
    email: 'contact@acme.com',
    phone: '+91-9000000000',
    contactPerson: { name: 'Acme Admin', phone: '+91-9000000000', email: 'admin@acme.com' },
    address: { line1: '42 Business Park', city: 'Mumbai', state: 'Maharashtra', country: 'India', pincode: '400001' },
    status: 'active',
  });
  // field-ops policy: strict 5m geo-fence (no outside check-in), hourly location capture
  acme.settings.geoFencing.radiusMeters = 5;
  acme.settings.geoFencing.allowOutsideWithReason = false;
  acme.settings.trackingIntervalMinutes = 60;
  // two-level leave approval chain (L1 manager -> L2 hr_admin; leaves of 5+ days escalate to L3)
  acme.settings.leave = { approvalLevels: 2, level3MinDays: 5 };
  await acme.save();
  console.log(`  ✔ Company: ${acme.name}`);

  // active Premium subscription (yearly)
  let subscription = await CompanySubscription.findOne({ companyId: acme._id, planId: plans.Premium._id, status: 'active' });
  if (!subscription) {
    subscription = await CompanySubscription.create({
      companyId: acme._id,
      planId: plans.Premium._id,
      startDate: dayjs().subtract(2, 'month').toDate(),
      endDate: dayjs().add(10, 'month').toDate(),
      billingCycle: 'yearly',
      status: 'active',
      employeeLimit: plans.Premium.employeeLimit,
      fieldEmployeeLimit: plans.Premium.fieldEmployeeLimit,
      amount: plans.Premium.yearlyPrice,
    });
  }
  // matching paid payment (revenue stats)
  await upsertByName(Payment, { companyId: acme._id, razorpayOrderId: 'order_seed_acme_premium' }, {
    subscriptionId: subscription._id,
    planId: plans.Premium._id,
    amount: plans.Premium.yearlyPrice,
    billingCycle: 'yearly',
    status: 'paid',
    mode: 'mock',
    razorpayPaymentId: 'pay_seed_acme_premium',
    invoiceNumber: 'INV-SEED-00001',
    paidAt: dayjs().subtract(2, 'month').toDate(),
  });
  console.log('  ✔ Premium subscription (active, yearly) + payment');

  // 4. Org setup
  const branch = await upsertByName(Branch, { companyId: acme._id, name: 'Head Office' }, {
    code: 'HO', address: '42 Business Park, Mumbai', city: 'Mumbai',
    location: { latitude: 19.076, longitude: 72.8777 },
  });
  const deptOps = await upsertByName(Department, { companyId: acme._id, name: 'Operations' }, { code: 'OPS' });
  const deptSales = await upsertByName(Department, { companyId: acme._id, name: 'Field Sales' }, { code: 'SALES' });
  const desigMgr = await upsertByName(Designation, { companyId: acme._id, name: 'Operations Manager' }, { level: 3, departmentId: deptOps._id });
  const desigExec = await upsertByName(Designation, { companyId: acme._id, name: 'Executive' }, { level: 1, departmentId: deptOps._id });
  const desigFieldExec = await upsertByName(Designation, { companyId: acme._id, name: 'Field Executive' }, { level: 1, departmentId: deptSales._id });
  const shift = await upsertByName(Shift, { companyId: acme._id, name: 'General Shift' }, {
    startTime: '09:30', endTime: '18:30', graceMinutes: 15, halfDayHours: 4, fullDayHours: 8, weekOffDays: [0],
  });
  await upsertByName(Holiday, { companyId: acme._id, name: 'Republic Day', date: `${dayjs().year()}-01-26` }, { year: dayjs().year(), type: 'public' });
  await upsertByName(Holiday, { companyId: acme._id, name: 'Independence Day', date: `${dayjs().year()}-08-15` }, { year: dayjs().year(), type: 'public' });
  console.log('  ✔ Branch, departments, designations, shift, holidays');

  // 5. Users + employees
  const adminUser = await upsertUser({
    name: 'Acme Admin', email: 'admin@acme.com', password: 'Admin@123', role: ROLES.COMPANY_ADMIN, companyId: acme._id,
  });

  const jobBase = {
    branchId: branch._id,
    shiftId: shift._id,
    joiningDate: dayjs().subtract(1, 'year').toDate(),
    employmentType: 'full_time',
  };
  const salaryBase = {
    ctc: 600000, basic: 25000, hra: 12500, conveyance: 1600, medicalAllowance: 1250,
    specialAllowance: 9650, otherAllowances: 0, pfApplicable: true, esiApplicable: false, ptApplicable: true, tdsPercent: 0,
  };

  // manager first (others reference managerId)
  const managerEmp = await upsertEmployee(acme._id, 'EMP0002', {
    personal: { firstName: 'Meera', lastName: 'Manager', email: 'manager@acme.com', phone: '+91-9000000002', gender: 'female' },
    job: { ...jobBase, departmentId: deptOps._id, designationId: desigMgr._id, employeeType: 'office_employee' },
    salary: { ...salaryBase, ctc: 900000, basic: 37500, hra: 18750 },
    onboardingStatus: 'active',
    status: 'active',
  });
  const managerUser = await upsertUser({
    name: 'Meera Manager', email: 'manager@acme.com', password: 'Manager@123', role: ROLES.MANAGER, companyId: acme._id, employeeId: managerEmp._id,
  });
  managerEmp.userId = managerUser._id;
  await managerEmp.save();

  const hrEmp = await upsertEmployee(acme._id, 'EMP0001', {
    personal: { firstName: 'Hina', lastName: 'HR', email: 'hr@acme.com', phone: '+91-9000000001', gender: 'female' },
    job: { ...jobBase, departmentId: deptOps._id, designationId: desigExec._id, employeeType: 'office_employee' },
    salary: salaryBase,
    onboardingStatus: 'active',
    status: 'active',
  });
  const hrUser = await upsertUser({
    name: 'Hina HR', email: 'hr@acme.com', password: 'Hr@12345', role: ROLES.HR_ADMIN, companyId: acme._id, employeeId: hrEmp._id,
  });
  hrEmp.userId = hrUser._id;
  await hrEmp.save();

  const johnEmp = await upsertEmployee(acme._id, 'EMP0003', {
    personal: { firstName: 'John', lastName: 'Doe', email: 'john@acme.com', phone: '+91-9000000003', gender: 'male' },
    job: { ...jobBase, departmentId: deptOps._id, designationId: desigExec._id, managerId: managerEmp._id, employeeType: 'office_employee' },
    salary: salaryBase,
    onboardingStatus: 'active',
    status: 'active',
  });
  const johnUser = await upsertUser({
    name: 'John Doe', email: 'john@acme.com', password: 'John@123', role: ROLES.EMPLOYEE, companyId: acme._id, employeeId: johnEmp._id,
  });
  johnEmp.userId = johnUser._id;
  await johnEmp.save();

  const fieldEmp = await upsertEmployee(acme._id, 'EMP0004', {
    personal: { firstName: 'Farid', lastName: 'Field', email: 'field@acme.com', phone: '+91-9000000004', gender: 'male' },
    job: { ...jobBase, departmentId: deptSales._id, designationId: desigFieldExec._id, managerId: managerEmp._id, employeeType: 'field_employee' },
    salary: { ...salaryBase, ctc: 480000, basic: 20000, hra: 10000 },
    field: { isFieldEmployee: true, vehicleType: 'bike', fieldAllowancePerDay: 150, travelAllowancePerKm: 4, trackingEnabled: true },
    biometricUserId: 'BIO-1004',
    onboardingStatus: 'active',
    status: 'active',
  });
  const fieldUser = await upsertUser({
    name: 'Farid Field', email: 'field@acme.com', password: 'Field@123', role: ROLES.FIELD_EMPLOYEE, companyId: acme._id, employeeId: fieldEmp._id,
  });
  fieldEmp.userId = fieldUser._id;
  await fieldEmp.save();

  const payrollEmp = await upsertEmployee(acme._id, 'EMP0005', {
    personal: { firstName: 'Paula', lastName: 'Payroll', email: 'payroll@acme.com', phone: '+91-9000000005', gender: 'female' },
    job: { ...jobBase, departmentId: deptOps._id, designationId: desigExec._id, employeeType: 'office_employee' },
    salary: salaryBase,
    onboardingStatus: 'active',
    status: 'active',
  });
  const payrollUser = await upsertUser({
    name: 'Paula Payroll', email: 'payroll@acme.com', password: 'Payroll@123', role: ROLES.PAYROLL_ADMIN, companyId: acme._id, employeeId: payrollEmp._id,
  });
  payrollEmp.userId = payrollUser._id;
  await payrollEmp.save();

  for (const emp of [hrEmp, managerEmp, johnEmp, fieldEmp, payrollEmp]) {
    await seedLeaveBalance(acme._id, emp._id);
  }
  console.log('  ✔ Users: admin@acme.com, hr@acme.com, manager@acme.com, john@acme.com, field@acme.com, payroll@acme.com');

  // 6. Clients with lat/lng
  const client1 = await upsertByName(Client, { companyId: acme._id, name: 'Globex Retail' }, {
    code: 'CL-001',
    contactPerson: 'Ravi Shah',
    phone: '+91-9111111111',
    email: 'ravi@globex.example',
    address: 'Andheri East, Mumbai',
    location: { latitude: 19.1136, longitude: 72.8697 },
    geoFenceRadiusMeters: 250,
  });
  const client2 = await upsertByName(Client, { companyId: acme._id, name: 'Initech Solutions' }, {
    code: 'CL-002',
    contactPerson: 'Sunita Rao',
    phone: '+91-9222222222',
    email: 'sunita@initech.example',
    address: 'Thane West, Thane',
    location: { latitude: 19.2183, longitude: 72.9781 },
    geoFenceRadiusMeters: 200,
  });
  console.log('  ✔ Clients: Globex Retail, Initech Solutions');

  // 7. Two field work assignments for TODAY
  const assignments = [
    {
      title: 'Product demo & installation',
      clientId: client1._id,
      clientLocation: { latitude: client1.location.latitude, longitude: client1.location.longitude, address: client1.address },
      startTime: '10:00',
      endTime: '12:00',
      priority: 'high',
    },
    {
      title: 'Quarterly service visit',
      clientId: client2._id,
      clientLocation: { latitude: client2.location.latitude, longitude: client2.location.longitude, address: client2.address },
      startTime: '14:30',
      endTime: '16:30',
      priority: 'medium',
    },
  ];
  for (const a of assignments) {
    await upsertByName(FieldWorkAssignment, { companyId: acme._id, employeeId: fieldEmp._id, title: a.title, date: today() }, {
      ...a,
      description: `${a.title} for the client`,
      status: 'assigned',
      assignedBy: managerUser._id,
      statusHistory: [{ status: 'assigned', by: managerUser._id }],
    });
  }
  console.log('  ✔ 2 field work assignments for today');

  // 8. Sample attendance (yesterday + day before)
  const att = async (employeeId, date, status, inH, outH) => {
    const checkIn = dayjs(`${date} ${inH}`).toDate();
    const checkOut = dayjs(`${date} ${outH}`).toDate();
    const workMinutes = Math.round((checkOut - checkIn) / 60000);
    await Attendance.findOneAndUpdate(
      { companyId: acme._id, employeeId, date },
      {
        $set: {
          shiftId: shift._id,
          checkIn: { time: checkIn, source: 'web' },
          checkOut: { time: checkOut, source: 'web' },
          status,
          attendanceSource: 'web',
          workMinutes,
          totalHours: Math.round((workMinutes / 60) * 100) / 100,
          lateMinutes: status === 'late' ? 25 : 0,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  };
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const dayBefore = dayjs().subtract(2, 'day').format('YYYY-MM-DD');
  await att(johnEmp._id, dayBefore, 'present', '09:25', '18:35');
  await att(johnEmp._id, yesterday, 'late', '10:10', '18:40');
  await att(fieldEmp._id, dayBefore, 'present', '09:40', '18:10');
  await att(fieldEmp._id, yesterday, 'present', '09:20', '18:45');
  await att(managerEmp._id, yesterday, 'present', '09:15', '19:00');
  console.log('  ✔ Sample attendance records');

  // 9. Sample leave records
  const leaveFrom = dayjs().add(7, 'day').format('YYYY-MM-DD');
  const leaveTo = dayjs().add(8, 'day').format('YYYY-MM-DD');
  await upsertByName(Leave, { companyId: acme._id, employeeId: johnEmp._id, fromDate: leaveFrom }, {
    leaveType: 'casual',
    toDate: leaveTo,
    days: 2,
    reason: 'Family function',
    status: 'pending',
  });
  const pastFrom = dayjs().subtract(10, 'day').format('YYYY-MM-DD');
  const existingApproved = await Leave.findOne({ companyId: acme._id, employeeId: fieldEmp._id, fromDate: pastFrom });
  if (!existingApproved) {
    await Leave.create({
      companyId: acme._id,
      employeeId: fieldEmp._id,
      leaveType: 'sick',
      fromDate: pastFrom,
      toDate: pastFrom,
      days: 1,
      reason: 'Fever',
      status: 'approved',
      approvedBy: managerUser._id,
      approvedAt: dayjs().subtract(9, 'day').toDate(),
    });
    const balance = await LeaveBalance.findOne({ companyId: acme._id, employeeId: fieldEmp._id, year: dayjs().year() });
    if (balance) {
      balance.balances.sick.used = (balance.balances.sick.used || 0) + 1;
      balance.markModified('balances');
      await balance.save();
    }
  }
  console.log('  ✔ Sample leave records');

  // 11. Demo loan — approved + disbursed for the office employee
  await upsertByName(Loan, { companyId: acme._id, employeeId: johnEmp._id, reason: 'Laptop purchase loan' }, {
    type: 'loan',
    amount: 30000,
    emiAmount: 5000,
    totalEmis: 6,
    paidEmis: 0,
    balance: 30000,
    payments: [], // reset the EMI ledger so verify reruns stay deterministic
    status: 'disbursed',
    approvedBy: adminUser._id,
    approvedAt: dayjs().subtract(5, 'day').toDate(),
    disbursedAt: dayjs().subtract(4, 'day').toDate(),
  });
  console.log('  ✔ 1 disbursed demo loan (john@acme.com)');

  // ==========================================================================
  // 12. Org depth — Bengaluru branch, Design & Accounts depts, 3 designations,
  //     evening shift, 3 more upcoming holidays
  // ==========================================================================
  const branchBlr = await upsertByName(Branch, { companyId: acme._id, name: 'Bengaluru Office' }, {
    code: 'BLR', address: '14 MG Road, Bengaluru', city: 'Bengaluru',
    location: { latitude: 12.9716, longitude: 77.5946 },
  });
  const deptDesign = await upsertByName(Department, { companyId: acme._id, name: 'Design' }, { code: 'DSGN' });
  const deptAccounts = await upsertByName(Department, { companyId: acme._id, name: 'Accounts' }, { code: 'ACC' });
  const desigDesigner = await upsertByName(Designation, { companyId: acme._id, name: 'Senior Interior Designer' }, { level: 2, departmentId: deptDesign._id });
  const desigAccountant = await upsertByName(Designation, { companyId: acme._id, name: 'Accountant' }, { level: 1, departmentId: deptAccounts._id });
  const desigSupervisor = await upsertByName(Designation, { companyId: acme._id, name: 'Site Supervisor' }, { level: 2, departmentId: deptOps._id });
  const eveningShift = await upsertByName(Shift, { companyId: acme._id, name: 'Evening Shift' }, {
    startTime: '14:00', endTime: '23:00', graceMinutes: 15, halfDayHours: 4, fullDayHours: 8, weekOffDays: [0],
  });
  await upsertByName(Holiday, { companyId: acme._id, name: 'Gandhi Jayanti', date: `${dayjs().year()}-10-02` }, { year: dayjs().year(), type: 'public' });
  await upsertByName(Holiday, { companyId: acme._id, name: 'Diwali', date: `${dayjs().year()}-11-08` }, { year: dayjs().year(), type: 'public' });
  await upsertByName(Holiday, { companyId: acme._id, name: 'Christmas', date: `${dayjs().year()}-12-25` }, { year: dayjs().year(), type: 'public' });
  console.log('  ✔ Bengaluru branch, Design/Accounts depts, 3 designations, evening shift, +3 holidays');

  // ==========================================================================
  // 13. More employees (total 12) — varied genders/DOBs/joining dates,
  //     2 birthdays in the next 7 days, an anniversary this week, a probation
  //     case, and a 3-level org tree under the Operations Manager
  // ==========================================================================
  const mkEmployee = async ({ code, first, last, email, phone, gender, dob, role, password, job, salary, field, biometricUserId }) => {
    const emp = await upsertEmployee(acme._id, code, {
      personal: { firstName: first, lastName: last, email, phone, gender, dob },
      job,
      salary,
      ...(field ? { field } : {}),
      ...(biometricUserId ? { biometricUserId } : {}),
      onboardingStatus: 'active',
      status: 'active',
    });
    const user = await upsertUser({ name: `${first} ${last}`, email, password, role, companyId: acme._id, employeeId: emp._id });
    emp.userId = user._id;
    await emp.save();
    await seedLeaveBalance(acme._id, emp._id);
    return { emp, user };
  };

  // Birthday in 3 days (celebrations card)
  const { emp: divyaEmp, user: divyaUser } = await mkEmployee({
    code: 'EMP0006', first: 'Divya', last: 'Sharma', email: 'divya@acme.com', phone: '+91-9886011001',
    gender: 'female', dob: dayjs().add(3, 'day').year(1995).toDate(), role: ROLES.MANAGER, password: 'Temp@1234',
    job: {
      branchId: branchBlr._id, shiftId: shift._id, departmentId: deptDesign._id, designationId: desigDesigner._id,
      managerId: managerEmp._id, joiningDate: dayjs().subtract(2, 'year').subtract(3, 'month').toDate(), employmentType: 'full_time', employeeType: 'office_employee',
    },
    salary: { ...salaryBase, ctc: 840000, basic: 35000, hra: 17500, specialAllowance: 14650 },
  });
  // Birthday in 5 days
  const { emp: arjunEmp, user: arjunUser } = await mkEmployee({
    code: 'EMP0007', first: 'Arjun', last: 'Nair', email: 'arjun@acme.com', phone: '+91-9886011002',
    gender: 'male', dob: dayjs().add(5, 'day').year(1992).toDate(), role: ROLES.EMPLOYEE, password: 'Temp@1234',
    job: {
      branchId: branch._id, shiftId: shift._id, departmentId: deptAccounts._id, designationId: desigAccountant._id,
      managerId: managerEmp._id, joiningDate: dayjs().subtract(18, 'month').toDate(), employmentType: 'full_time', employeeType: 'office_employee',
    },
    salary: { ...salaryBase, ctc: 540000, basic: 22500, hra: 11250 },
    biometricUserId: 'BIO-1007',
  });
  // Second field employee (Bengaluru)
  const { emp: kavyaEmp, user: kavyaUser } = await mkEmployee({
    code: 'EMP0008', first: 'Kavya', last: 'Reddy', email: 'kavya@acme.com', phone: '+91-9886011003',
    gender: 'female', dob: new Date('1997-09-21'), role: ROLES.FIELD_EMPLOYEE, password: 'Temp@1234',
    job: {
      branchId: branchBlr._id, shiftId: shift._id, departmentId: deptSales._id, designationId: desigFieldExec._id,
      managerId: managerEmp._id, joiningDate: dayjs().subtract(8, 'month').toDate(), employmentType: 'full_time', employeeType: 'field_employee',
    },
    salary: { ...salaryBase, ctc: 420000, basic: 17500, hra: 8750, specialAllowance: 7000 },
    field: { isFieldEmployee: true, vehicleType: 'bike', fieldAllowancePerDay: 150, travelAllowancePerKm: 4, trackingEnabled: true },
  });
  // Probation: confirmation due ~10 days from now; 3rd level of the org tree (reports to John)
  const { emp: rohanEmp } = await mkEmployee({
    code: 'EMP0009', first: 'Rohan', last: 'Kulkarni', email: 'rohan@acme.com', phone: '+91-9886011004',
    gender: 'male', dob: new Date('1999-01-30'), role: ROLES.EMPLOYEE, password: 'Temp@1234',
    job: {
      branchId: branch._id, shiftId: shift._id, departmentId: deptOps._id, designationId: desigExec._id,
      managerId: johnEmp._id, joiningDate: dayjs().subtract(80, 'day').toDate(),
      probationEndDate: dayjs().add(10, 'day').toDate(), confirmationStatus: 'probation',
      employmentType: 'full_time', employeeType: 'office_employee',
    },
    salary: { ...salaryBase, ctc: 420000, basic: 17500, hra: 8750, specialAllowance: 7000 },
  });
  // 3rd level on the Design side (reports to Divya), evening shift
  const { emp: snehaEmp, user: snehaUser } = await mkEmployee({
    code: 'EMP0010', first: 'Sneha', last: 'Iyer', email: 'sneha@acme.com', phone: '+91-9886011005',
    gender: 'female', dob: new Date('1996-04-12'), role: ROLES.EMPLOYEE, password: 'Temp@1234',
    job: {
      branchId: branchBlr._id, shiftId: eveningShift._id, departmentId: deptDesign._id, designationId: desigExec._id,
      managerId: divyaEmp._id, joiningDate: dayjs().subtract(3, 'year').subtract(40, 'day').toDate(), employmentType: 'full_time', employeeType: 'office_employee',
    },
    salary: { ...salaryBase, ctc: 480000, basic: 20000, hra: 10000 },
  });
  // Third field employee (Site Supervisor, Head Office)
  const { emp: vikrantEmp } = await mkEmployee({
    code: 'EMP0011', first: 'Vikrant', last: 'Singh', email: 'vikrant@acme.com', phone: '+91-9886011006',
    gender: 'male', dob: new Date('1990-12-05'), role: ROLES.FIELD_EMPLOYEE, password: 'Temp@1234',
    job: {
      branchId: branch._id, shiftId: shift._id, departmentId: deptOps._id, designationId: desigSupervisor._id,
      managerId: managerEmp._id, joiningDate: dayjs().subtract(14, 'month').toDate(), employmentType: 'full_time', employeeType: 'field_employee',
    },
    salary: { ...salaryBase, ctc: 600000, basic: 25000, hra: 12500 },
    field: { isFieldEmployee: true, vehicleType: 'car', fieldAllowancePerDay: 200, travelAllowancePerKm: 6, trackingEnabled: true },
  });
  // Work anniversary in 2 days (2 years)
  const { emp: ananyaEmp } = await mkEmployee({
    code: 'EMP0012', first: 'Ananya', last: 'Das', email: 'ananya@acme.com', phone: '+91-9886011007',
    gender: 'female', dob: new Date('1994-08-19'), role: ROLES.EMPLOYEE, password: 'Temp@1234',
    job: {
      branchId: branch._id, shiftId: eveningShift._id, departmentId: deptAccounts._id, designationId: desigAccountant._id,
      managerId: managerEmp._id, joiningDate: dayjs().add(2, 'day').subtract(2, 'year').toDate(), employmentType: 'full_time', employeeType: 'office_employee',
    },
    salary: { ...salaryBase, ctc: 540000, basic: 22500, hra: 11250 },
  });
  console.log('  ✔ 7 more employees (EMP0006–EMP0012, logins <name>@acme.com / Temp@1234)');

  // ==========================================================================
  // 14. More clients — total 5 (3 geo-tagged, 2 address-only)
  // ==========================================================================
  const clientPrestige = await upsertByName(Client, { companyId: acme._id, name: 'Prestige Estates' }, {
    code: 'CL-003',
    contactPerson: 'Mohit Jain',
    phone: '+91-9333344441',
    email: 'mohit@prestige.example',
    address: 'Koramangala, Bengaluru',
    location: { latitude: 12.9352, longitude: 77.6245 },
    geoFenceRadiusMeters: 250,
  });
  const clientLotus = await upsertByName(Client, { companyId: acme._id, name: 'Lotus Hospitals' }, {
    code: 'CL-004',
    contactPerson: 'Dr. Rekha Nambiar',
    phone: '+91-9333344442',
    email: 'rekha@lotus.example',
    address: 'Indiranagar 100 Feet Road, Bengaluru',
  });
  const clientSharma = await upsertByName(Client, { companyId: acme._id, name: 'Sharma Textiles' }, {
    code: 'CL-005',
    contactPerson: 'Naresh Sharma',
    phone: '+91-9333344443',
    email: 'naresh@sharmatextiles.example',
    address: 'Dadar West, Mumbai',
  });
  console.log('  ✔ Clients total 5 (added Prestige Estates, Lotus Hospitals, Sharma Textiles)');

  // ==========================================================================
  // 15. More work assignments — 8 across yesterday/today/tomorrow/next week
  //     (the 2 original today-assignments for field@acme.com stay untouched)
  // ==========================================================================
  const visitDate1 = prevWorking(1).format('YYYY-MM-DD'); // Farid — past, completed visit
  const visitDate2 = prevWorking(2).format('YYYY-MM-DD'); // Kavya — past, completed visit
  const upsertAssignment = (employeeId, title, date, data) =>
    upsertByName(FieldWorkAssignment, { companyId: acme._id, employeeId, title, date }, { assignedBy: managerUser._id, ...data });

  const asgFaridPast = await upsertAssignment(fieldEmp._id, 'Site measurement & material estimate', visitDate1, {
    clientId: client1._id,
    clientLocation: { latitude: client1.location.latitude, longitude: client1.location.longitude, address: client1.address },
    description: 'Measure store interiors and estimate material for renovation',
    startTime: '10:00', endTime: '17:00', priority: 'high', status: 'checked_out',
    checklist: [
      { label: 'Measure floor area', completed: true, completedAt: dayjs(`${visitDate1} 11:30`).toDate() },
      { label: 'Photograph existing fittings', completed: true, completedAt: dayjs(`${visitDate1} 12:15`).toDate() },
      { label: 'Share estimate with client', completed: true, completedAt: dayjs(`${visitDate1} 16:45`).toDate() },
    ],
    statusHistory: [
      { status: 'assigned', by: managerUser._id, at: dayjs(`${visitDate1} 08:00`).toDate() },
      { status: 'on_the_way', by: fieldUser._id, at: dayjs(`${visitDate1} 09:05`).toDate() },
      { status: 'reached', by: fieldUser._id, at: dayjs(`${visitDate1} 09:35`).toDate() },
      { status: 'checked_in', by: fieldUser._id, at: dayjs(`${visitDate1} 09:40`).toDate() },
      { status: 'in_progress', by: fieldUser._id, at: dayjs(`${visitDate1} 09:45`).toDate() },
      { status: 'completed', by: fieldUser._id, at: dayjs(`${visitDate1} 17:10`).toDate() },
      { status: 'checked_out', by: fieldUser._id, at: dayjs(`${visitDate1} 17:30`).toDate() },
    ],
  });
  const asgKavyaPast = await upsertAssignment(kavyaEmp._id, 'AC installation survey', visitDate2, {
    clientId: clientPrestige._id,
    clientLocation: { latitude: clientPrestige.location.latitude, longitude: clientPrestige.location.longitude, address: clientPrestige.address },
    description: 'Survey duct routing for split AC installation at sales office',
    startTime: '10:00', endTime: '17:00', priority: 'medium', status: 'checked_out',
    checklist: [
      { label: 'Inspect electrical load', completed: true, completedAt: dayjs(`${visitDate2} 11:00`).toDate() },
      { label: 'Finalize unit placement', completed: true, completedAt: dayjs(`${visitDate2} 15:30`).toDate() },
    ],
    statusHistory: [
      { status: 'assigned', by: managerUser._id, at: dayjs(`${visitDate2} 08:00`).toDate() },
      { status: 'on_the_way', by: kavyaUser._id, at: dayjs(`${visitDate2} 09:00`).toDate() },
      { status: 'reached', by: kavyaUser._id, at: dayjs(`${visitDate2} 09:35`).toDate() },
      { status: 'checked_in', by: kavyaUser._id, at: dayjs(`${visitDate2} 09:40`).toDate() },
      { status: 'in_progress', by: kavyaUser._id, at: dayjs(`${visitDate2} 09:50`).toDate() },
      { status: 'completed', by: kavyaUser._id, at: dayjs(`${visitDate2} 17:05`).toDate() },
      { status: 'checked_out', by: kavyaUser._id, at: dayjs(`${visitDate2} 17:30`).toDate() },
    ],
  });
  await upsertAssignment(kavyaEmp._id, 'Sample delivery & briefing', today(), {
    clientId: clientLotus._id,
    clientLocation: { address: clientLotus.address },
    description: 'Deliver laminate samples and brief the purchase team',
    startTime: '11:00', endTime: '13:00', priority: 'medium', status: 'on_the_way',
    checklist: [{ label: 'Collect samples from office', completed: true, completedAt: dayjs().hour(9).minute(45).toDate() }, { label: 'Get sample sign-off', completed: false }],
    statusHistory: [
      { status: 'assigned', by: managerUser._id, at: dayjs().subtract(1, 'day').toDate() },
      { status: 'on_the_way', by: kavyaUser._id, at: dayjs().hour(10).minute(10).toDate() },
    ],
  });
  await upsertAssignment(vikrantEmp._id, 'Electrical safety audit', today(), {
    clientId: client2._id,
    clientLocation: { latitude: client2.location.latitude, longitude: client2.location.longitude, address: client2.address },
    description: 'Annual electrical safety audit of server room and pantry',
    startTime: '15:00', endTime: '17:30', priority: 'high', status: 'assigned',
    checklist: [{ label: 'Check earthing readings', completed: false }, { label: 'Submit audit checklist', completed: false }],
    statusHistory: [{ status: 'assigned', by: managerUser._id, at: dayjs().hour(8).minute(30).toDate() }],
  });
  // multi-day job started yesterday and still in progress
  await upsertAssignment(kavyaEmp._id, 'Showroom branding setup', visitDate1, {
    clientId: clientSharma._id,
    clientLocation: { address: clientSharma.address },
    description: 'Multi-day branding & signage installation across two floors',
    startTime: '09:30', priority: 'high', status: 'in_progress',
    expectedDurationMinutes: 960,
    checklist: [
      { label: 'Ground floor signage', completed: true, completedAt: dayjs(`${visitDate1} 18:00`).toDate() },
      { label: 'First floor wall branding', completed: false },
      { label: 'Final client walkthrough', completed: false },
    ],
    statusHistory: [
      { status: 'assigned', by: managerUser._id, at: dayjs(`${visitDate1} 08:30`).toDate() },
      { status: 'on_the_way', by: kavyaUser._id, at: dayjs(`${visitDate1} 09:00`).toDate() },
      { status: 'reached', by: kavyaUser._id, at: dayjs(`${visitDate1} 09:25`).toDate() },
      { status: 'checked_in', by: kavyaUser._id, at: dayjs(`${visitDate1} 09:30`).toDate() },
      { status: 'in_progress', by: kavyaUser._id, at: dayjs(`${visitDate1} 09:40`).toDate() },
    ],
  });
  await upsertAssignment(fieldEmp._id, 'Follow-up service visit', dayjs().add(1, 'day').format('YYYY-MM-DD'), {
    clientId: client2._id,
    clientLocation: { latitude: client2.location.latitude, longitude: client2.location.longitude, address: client2.address },
    description: 'Post-installation follow-up and feedback collection',
    startTime: '10:30', endTime: '12:30', priority: 'medium', status: 'assigned',
    checklist: [{ label: 'Collect feedback form', completed: false }],
    statusHistory: [{ status: 'assigned', by: managerUser._id }],
  });
  await upsertAssignment(fieldEmp._id, 'AMC renewal discussion', dayjs().add(6, 'day').format('YYYY-MM-DD'), {
    clientId: client1._id,
    clientLocation: { latitude: client1.location.latitude, longitude: client1.location.longitude, address: client1.address },
    description: 'Discuss annual maintenance contract renewal terms',
    startTime: '11:00', endTime: '12:00', priority: 'low', status: 'assigned',
    checklist: [{ label: 'Carry renewed AMC draft', completed: false }],
    statusHistory: [{ status: 'assigned', by: managerUser._id }],
  });
  await upsertAssignment(fieldEmp._id, 'Quotation drop-off', today(), {
    clientId: clientSharma._id,
    clientLocation: { address: clientSharma.address },
    description: 'Hand over printed quotation to the client',
    startTime: '17:00', endTime: '17:30', priority: 'low', status: 'cancelled',
    cancelReason: 'Client asked to email the quotation instead',
    checklist: [{ label: 'Print quotation', completed: true, completedAt: dayjs().hour(9).toDate() }],
    statusHistory: [
      { status: 'assigned', by: managerUser._id, at: dayjs().hour(8).toDate() },
      { status: 'cancelled', by: managerUser._id, at: dayjs().hour(9).minute(30).toDate(), note: 'Client asked to email the quotation instead' },
    ],
  });
  console.log('  ✔ 8 more work assignments (yesterday/today/tomorrow/next week, mixed statuses)');

  // ==========================================================================
  // 16. Field visits + GPS route logs + visit-derived attendance + expenses
  // ==========================================================================
  const seedVisit = async ({ assignment, employee, client, date }) => {
    const checkInTime = dayjs(`${date} 09:40`).toDate();
    const checkOutTime = dayjs(`${date} 17:30`).toDate();
    const loc = { latitude: client.location.latitude, longitude: client.location.longitude, accuracy: 8, address: client.address };
    const visit = await upsertByName(FieldVisit, { companyId: acme._id, workAssignmentId: assignment._id, date }, {
      employeeId: employee._id,
      clientId: client._id,
      checkInTime,
      checkInLocation: loc,
      checkOutTime,
      checkOutLocation: loc,
      remarks: 'Work completed and verified with client',
      totalWorkMinutes: 470,
      distanceMeters: 3,
      status: 'checked_out',
      approvalStatus: 'none',
      proofStatus: 'submitted',
    });

    // ~8 GPS points: branch → client in the morning, around the client all day
    const home = employee.job.branchId && String(employee.job.branchId) === String(branchBlr._id)
      ? branchBlr.location
      : branch.location;
    const times = ['09:00', '09:20', '09:40', '11:00', '12:30', '14:00', '15:30', '17:30'];
    const logOps = times.map((t, i) => {
      const ratio = Math.min(i / 2, 1); // reaches the client by the 3rd point
      const latitude = home.latitude + (client.location.latitude - home.latitude) * ratio + (i > 2 ? 0.0004 * (i % 2) : 0);
      const longitude = home.longitude + (client.location.longitude - home.longitude) * ratio + (i > 2 ? 0.0003 * ((i + 1) % 2) : 0);
      const trackingType = t === '09:40' ? 'checkin' : t === '17:30' ? 'checkout' : 'interval';
      return {
        updateOne: {
          filter: { companyId: acme._id, employeeId: employee._id, capturedAt: dayjs(`${date} ${t}`).toDate() },
          update: {
            $set: {
              workAssignmentId: assignment._id,
              latitude: Math.round(latitude * 1e6) / 1e6,
              longitude: Math.round(longitude * 1e6) / 1e6,
              accuracy: 10,
              batteryLevel: 95 - i * 8,
              trackingType,
            },
          },
          upsert: true,
        },
      };
    });
    await FieldLocationLog.bulkWrite(logOps);

    // matching attendance row derived from the visit
    await Attendance.findOneAndUpdate(
      { companyId: acme._id, employeeId: employee._id, date },
      {
        $set: {
          shiftId: shift._id,
          status: 'present',
          attendanceSource: 'field_visit',
          checkIn: { time: checkInTime, location: { latitude: loc.latitude, longitude: loc.longitude }, source: 'field_visit' },
          checkOut: { time: checkOutTime, location: { latitude: loc.latitude, longitude: loc.longitude }, source: 'field_visit' },
          workMinutes: 470,
          totalHours: 7.83,
          lateMinutes: 0,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    return visit;
  };

  await seedVisit({ assignment: asgFaridPast, employee: fieldEmp, user: fieldUser, client: client1, date: visitDate1 });
  await seedVisit({ assignment: asgKavyaPast, employee: kavyaEmp, user: kavyaUser, client: clientPrestige, date: visitDate2 });

  // 3 field expenses tied to those visits
  await upsertByName(FieldExpense, { companyId: acme._id, employeeId: fieldEmp._id, date: visitDate1, category: 'travel' }, {
    workAssignmentId: asgFaridPast._id, amount: 180, description: 'Bike fuel — office to Andheri and back', status: 'submitted',
  });
  await upsertByName(FieldExpense, { companyId: acme._id, employeeId: fieldEmp._id, date: visitDate1, category: 'food' }, {
    workAssignmentId: asgFaridPast._id, amount: 120, description: 'Lunch during full-day client visit', status: 'approved',
    actionBy: managerUser._id, actionAt: dayjs(`${visitDate1} 19:00`).toDate(),
  });
  await upsertByName(FieldExpense, { companyId: acme._id, employeeId: kavyaEmp._id, date: visitDate2, category: 'parking' }, {
    workAssignmentId: asgKavyaPast._id, amount: 60, description: 'Mall parking at client site', status: 'paid',
    actionBy: managerUser._id, actionAt: dayjs(`${visitDate2} 19:00`).toDate(),
    paidAt: dayjs(`${visitDate1} 12:00`).toDate(), paidBy: adminUser._id,
  });
  console.log('  ✔ 2 complete field visits + GPS routes + visit attendance + 3 field expenses');

  // ==========================================================================
  // 17. Attendance history (start of last month → yesterday, working days),
  //     2 corrections, 1 biometric device + logs
  // ==========================================================================
  const allEmps = [hrEmp, managerEmp, johnEmp, fieldEmp, payrollEmp, divyaEmp, arjunEmp, kavyaEmp, rohanEmp, snehaEmp, vikrantEmp, ananyaEmp];
  // Sneha was on approved leave on these two working days (also seeded in section 18)
  const snehaLeaveDates = [prevWorking(4).format('YYYY-MM-DD'), prevWorking(3).format('YYYY-MM-DD')];

  const workingDays = [];
  let cursor = dayjs().subtract(1, 'month').startOf('month');
  const lastDay = dayjs().subtract(1, 'day');
  while (cursor.isBefore(lastDay) || cursor.isSame(lastDay, 'day')) {
    if (cursor.day() !== 0) workingDays.push(cursor.format('YYYY-MM-DD'));
    cursor = cursor.add(1, 'day');
  }

  const sources = ['web', 'employee_app', 'manual'];
  const attOps = [];
  allEmps.forEach((emp, i) => {
    const isField = emp.job.employeeType === 'field_employee';
    workingDays.forEach((date, j) => {
      if (dayjs(date).isBefore(dayjs(emp.job.joiningDate), 'day')) return;
      let status = 'present';
      let inTime = '09:25';
      let outTime = '18:35';
      let lateMinutes = 0;
      const r = (i * 3 + j) % 11;
      if (!isField) {
        if (snehaLeaveDates.includes(date) && String(emp._id) === String(snehaEmp._id)) status = 'on_leave';
        else if (r === 0) { status = 'late'; inTime = '09:52'; lateMinutes = 22; }
        else if (r === 1) status = 'wfh';
        else if (r === 2) { status = 'half_day'; outTime = '13:30'; }
        else if (r === 3) status = 'absent';
      }
      const source = isField ? (j % 2 ? 'employee_app' : 'field_visit') : sources[(i + j) % 3];
      const set = { shiftId: emp.job.shiftId, status, attendanceSource: source, lateMinutes, earlyExitMinutes: 0 };
      if (status === 'absent' || status === 'on_leave') {
        Object.assign(set, { checkIn: null, checkOut: null, workMinutes: 0, totalHours: 0 });
      } else {
        const checkIn = dayjs(`${date} ${inTime}`).toDate();
        const checkOut = dayjs(`${date} ${outTime}`).toDate();
        const workMinutes = Math.round((checkOut - checkIn) / 60000);
        Object.assign(set, {
          checkIn: { time: checkIn, source },
          checkOut: { time: checkOut, source },
          workMinutes,
          totalHours: Math.round((workMinutes / 60) * 100) / 100,
        });
      }
      attOps.push({
        updateOne: {
          filter: { companyId: acme._id, employeeId: emp._id, date },
          update: { $set: set },
          upsert: true,
        },
      });
    });
  });
  await Attendance.bulkWrite(attOps);

  // re-apply the 2 visit-derived rows (the loop above overwrote those dates)
  await seedVisit({ assignment: asgFaridPast, employee: fieldEmp, user: fieldUser, client: client1, date: visitDate1 });
  await seedVisit({ assignment: asgKavyaPast, employee: kavyaEmp, user: kavyaUser, client: clientPrestige, date: visitDate2 });

  const corrDate1 = prevWorking(3).format('YYYY-MM-DD');
  const corrDate2 = prevWorking(5).format('YYYY-MM-DD');
  await upsertByName(AttendanceCorrection, { companyId: acme._id, employeeId: johnEmp._id, date: corrDate1 }, {
    requestedCheckIn: dayjs(`${corrDate1} 09:20`).toDate(),
    requestedCheckOut: dayjs(`${corrDate1} 18:30`).toDate(),
    requestedStatus: 'present',
    reason: 'Forgot to punch in — was at office by 9:20 (badge entry can confirm)',
    status: 'pending',
  });
  await upsertByName(AttendanceCorrection, { companyId: acme._id, employeeId: arjunEmp._id, date: corrDate2 }, {
    requestedCheckOut: dayjs(`${corrDate2} 19:15`).toDate(),
    requestedStatus: 'present',
    reason: 'Worked late on month-end closing; checkout not recorded',
    status: 'approved',
    managerActionBy: managerUser._id,
    managerActionAt: dayjs(`${corrDate2} 20:00`).add(1, 'day').toDate(),
    hrActionBy: hrUser._id,
    hrActionAt: dayjs(`${corrDate2} 21:00`).add(1, 'day').toDate(),
  });

  const bioDevice = await upsertByName(BiometricDevice, { companyId: acme._id, deviceKey: 'ESSL-ACME-HO-01' }, {
    name: 'eSSL X990 — Head Office',
    branchId: branch._id,
    location: 'Head Office reception, Mumbai',
    isActive: true,
    lastSeenAt: dayjs().subtract(20, 'minute').toDate(),
  });
  const bioLogs = [];
  for (const { uid, empId } of [{ uid: 'BIO-1004', empId: fieldEmp._id }, { uid: 'BIO-1007', empId: arjunEmp._id }]) {
    for (const [t, direction] of [['09:31', 'in'], ['18:22', 'out']]) {
      bioLogs.push({
        updateOne: {
          filter: { companyId: acme._id, biometricUserId: uid, timestamp: dayjs(`${visitDate1} ${t}`).toDate() },
          update: { $set: { deviceId: bioDevice._id, employeeId: empId, direction, processed: true, raw: { punch: t } } },
          upsert: true,
        },
      });
    }
  }
  await BiometricLog.bulkWrite(bioLogs);
  console.log(`  ✔ Attendance for ${workingDays.length} working days × ${allEmps.length} employees, 2 corrections, biometric device + 4 logs`);

  // ==========================================================================
  // 18. Leave requests — all statuses (existing: 1 pending + 1 approved)
  // ==========================================================================
  const snehaLeave = await Leave.findOne({ companyId: acme._id, employeeId: snehaEmp._id, fromDate: snehaLeaveDates[0] });
  if (!snehaLeave) {
    await Leave.create({
      companyId: acme._id,
      employeeId: snehaEmp._id,
      leaveType: 'earned',
      fromDate: snehaLeaveDates[0],
      toDate: snehaLeaveDates[1],
      days: 2,
      reason: 'Out-of-town family commitment',
      status: 'approved',
      approvedBy: managerUser._id,
      approvedAt: dayjs(snehaLeaveDates[0]).subtract(2, 'day').toDate(),
    });
    const snehaBal = await LeaveBalance.findOne({ companyId: acme._id, employeeId: snehaEmp._id, year: dayjs().year() });
    if (snehaBal) {
      snehaBal.balances.earned.used = (snehaBal.balances.earned.used || 0) + 2;
      snehaBal.markModified('balances');
      await snehaBal.save();
    }
  }
  await upsertByName(Leave, { companyId: acme._id, employeeId: arjunEmp._id, fromDate: prevWorking(6).format('YYYY-MM-DD') }, {
    leaveType: 'casual',
    toDate: prevWorking(6).format('YYYY-MM-DD'),
    days: 1,
    reason: 'Personal errand',
    status: 'rejected',
    approvedBy: managerUser._id,
    approvedAt: prevWorking(6).subtract(1, 'day').toDate(),
    rejectionReason: 'Month-end closing — please reschedule',
  });
  await upsertByName(Leave, { companyId: acme._id, employeeId: divyaEmp._id, fromDate: dayjs().add(3, 'day').format('YYYY-MM-DD') }, {
    leaveType: 'sick',
    toDate: dayjs().add(3, 'day').format('YYYY-MM-DD'),
    days: 1,
    reason: 'Dental appointment',
    status: 'cancelled',
    cancelledAt: dayjs().subtract(1, 'day').toDate(),
  });
  // pending request spanning next week
  await upsertByName(Leave, { companyId: acme._id, employeeId: kavyaEmp._id, fromDate: dayjs().add(6, 'day').format('YYYY-MM-DD') }, {
    leaveType: 'casual',
    toDate: dayjs().add(9, 'day').format('YYYY-MM-DD'),
    days: 4,
    reason: 'Cousin\'s wedding in Hyderabad',
    status: 'pending',
  });
  console.log('  ✔ Leave requests across pending/approved/rejected/cancelled (one spanning next week)');

  // ==========================================================================
  // 19. CRM — 3 more loans
  // ==========================================================================
  // 3 more loans: requested / disbursed with 2 EMIs paid / closed
  await upsertByName(Loan, { companyId: acme._id, employeeId: rohanEmp._id, reason: 'Relocation travel advance' }, {
    type: 'advance',
    amount: 8000,
    payments: [],
    status: 'requested',
  });
  // 2/6 EMIs paid with NO ledger entries — exercises the legacy synthetic-schedule path
  await upsertByName(Loan, { companyId: acme._id, employeeId: managerEmp._id, reason: 'Home renovation loan' }, {
    type: 'loan',
    amount: 60000,
    emiAmount: 10000,
    totalEmis: 6,
    paidEmis: 2,
    balance: 40000,
    payments: [], // reset the EMI ledger so verify reruns stay deterministic
    status: 'disbursed',
    approvedBy: adminUser._id,
    approvedAt: dayjs().subtract(3, 'month').toDate(),
    disbursedAt: dayjs().subtract(3, 'month').add(1, 'day').toDate(),
  });
  await upsertByName(Loan, { companyId: acme._id, employeeId: payrollEmp._id, reason: 'Festival season advance' }, {
    type: 'loan',
    amount: 20000,
    emiAmount: 5000,
    totalEmis: 4,
    paidEmis: 4,
    balance: 0,
    payments: [],
    status: 'closed',
    approvedBy: adminUser._id,
    approvedAt: dayjs().subtract(6, 'month').toDate(),
    disbursedAt: dayjs().subtract(6, 'month').add(1, 'day').toDate(),
    closedAt: dayjs().subtract(1, 'month').toDate(),
  });
  console.log('  ✔ Loans total 4 (requested/disbursed×2/closed)');

  // 2 demo increment requests — open one for John, approved one for Divya
  await upsertByName(IncrementRequest, { companyId: acme._id, employeeId: johnEmp._id, requestedCtc: 720000 }, {
    currentCtc: 600000,
    reason: 'Consistent delivery on Operations KPIs over the last 12 months',
    status: 'requested',
    reviewNote: null,
    actionBy: null,
    actionAt: null,
  });
  await upsertByName(IncrementRequest, { companyId: acme._id, employeeId: divyaEmp._id, requestedCtc: 950000 }, {
    currentCtc: 840000,
    reason: 'Design vertical doubled its billing under my lead this year',
    status: 'approved',
    reviewNote: 'Approved in the annual review cycle — revision effective next quarter',
    actionBy: hrUser._id,
    actionAt: dayjs().subtract(2, 'day').toDate(),
  });
  console.log('  ✔ 2 demo increment requests (john: requested 600000→720000, divya: approved)');

  // ==========================================================================
  // 20. Payroll for LAST month — real calculation via payroll.service
  //     (~half paid → visible as payslips in the app; rest approved)
  // ==========================================================================
  const payMonthRef = dayjs().subtract(1, 'month');
  const payMonth = payMonthRef.month() + 1;
  const payYear = payMonthRef.year();
  // stale CURRENT-month payroll left behind by ad-hoc testing breaks the
  // deterministic /payroll/generate flow — knock non-locked rows back to draft
  await Payroll.updateMany(
    { companyId: acme._id, month: dayjs().month() + 1, year: dayjs().year(), status: { $in: ['approved', 'paid'] } },
    { $set: { status: 'draft', approvedBy: null, approvedAt: null, paidAt: null, payslipEmailedAt: null, loanEmisPosted: false } }
  );
  const paidSet = new Set([fieldEmp, johnEmp, hrEmp, divyaEmp, kavyaEmp, ananyaEmp].map((e) => String(e._id)));
  let paidCount = 0;
  let approvedCount = 0;
  for (const emp of allEmps) {
    // eslint-disable-next-line no-await-in-loop
    const calc = await calculateForEmployee({ company: acme, employee: emp, month: payMonth, year: payYear });
    const isPaid = paidSet.has(String(emp._id));
    const statusFields = isPaid
      ? {
          status: 'paid',
          approvedBy: adminUser._id,
          approvedAt: payMonthRef.endOf('month').toDate(),
          paidAt: dayjs().startOf('month').hour(10).toDate(),
          payslipEmailedAt: null, // re-armed every reseed so email-payslips has work to do
          loanEmisPosted: true, // EMIs already reflected in seeded loan balances
        }
      : {
          status: 'approved',
          approvedBy: adminUser._id,
          approvedAt: payMonthRef.endOf('month').toDate(),
          paidAt: null,
          payslipEmailedAt: null,
          loanEmisPosted: false,
        };
    // eslint-disable-next-line no-await-in-loop
    await Payroll.findOneAndUpdate(
      { companyId: acme._id, employeeId: emp._id, month: payMonth, year: payYear },
      { $set: { ...calc, generatedBy: adminUser._id, ...statusFields } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    if (isPaid) paidCount += 1; else approvedCount += 1;
  }
  console.log(`  ✔ Payroll ${payMonth}/${payYear}: ${paidCount} paid + ${approvedCount} approved (field@acme.com & john@acme.com paid)`);

  // ==========================================================================
  // 21. Talent — recruitment, candidates, performance, tasks, assets, documents
  // ==========================================================================
  const jobDesigner = await upsertByName(RecruitmentJob, { companyId: acme._id, title: 'Interior Designer' }, {
    departmentId: deptDesign._id,
    designationId: desigDesigner._id,
    branchId: branchBlr._id,
    description: 'Design residential & commercial interiors; 3+ years with AutoCAD/SketchUp.',
    openings: 2,
    employmentType: 'full_time',
    salaryRange: { min: 400000, max: 700000 },
    skills: ['AutoCAD', 'SketchUp', '3ds Max', 'Client presentations'],
    status: 'open',
    postedBy: hrUser._id,
    closingDate: dayjs().add(30, 'day').toDate(),
  });
  const jobSales = await upsertByName(RecruitmentJob, { companyId: acme._id, title: 'Field Sales Executive' }, {
    departmentId: deptSales._id,
    designationId: desigFieldExec._id,
    branchId: branch._id,
    description: 'On-ground client visits, lead follow-ups and order closures across Mumbai.',
    openings: 3,
    employmentType: 'full_time',
    salaryRange: { min: 300000, max: 450000 },
    skills: ['B2B sales', 'Negotiation', 'Two-wheeler with licence'],
    status: 'open',
    postedBy: hrUser._id,
    closingDate: dayjs().add(21, 'day').toDate(),
  });
  const candidates = [
    { jobId: jobDesigner._id, name: 'Ishita Verma', email: 'ishita.verma@example.com', phone: '+91-9871230001', currentCompany: 'DecorNest', experienceYears: 4, expectedSalary: 650000, status: 'applied' },
    { jobId: jobDesigner._id, name: 'Sahil Khanna', email: 'sahil.khanna@example.com', phone: '+91-9871230002', currentCompany: 'UrbanSpaces', experienceYears: 3, expectedSalary: 550000, status: 'screening' },
    { jobId: jobDesigner._id, name: 'Nandini Pillai', email: 'nandini.pillai@example.com', phone: '+91-9871230003', currentCompany: 'Studio Arc', experienceYears: 5, expectedSalary: 700000, status: 'interview', interviewDate: dayjs().add(3, 'day').hour(11).toDate(), rating: 4 },
    { jobId: jobSales._id, name: 'Deepak Yadav', email: 'deepak.yadav@example.com', phone: '+91-9871230004', currentCompany: 'FurniMart', experienceYears: 2, expectedSalary: 380000, status: 'shortlisted' },
    { jobId: jobSales._id, name: 'Ritika Joshi', email: 'ritika.joshi@example.com', phone: '+91-9871230005', currentCompany: 'HomeKraft', experienceYears: 3, expectedSalary: 420000, status: 'offered', rating: 4 },
    { jobId: jobSales._id, name: 'Mohammed Faizal', email: 'mohammed.faizal@example.com', phone: '+91-9871230006', currentCompany: 'CityFurnish', experienceYears: 4, expectedSalary: 440000, status: 'hired', rating: 5 },
  ];
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Candidate, { companyId: acme._id, email: c.email }, c);
  }

  const qIdx = Math.floor(dayjs().month() / 3);
  const qStart = dayjs().month(qIdx * 3).startOf('month');
  const qEnd = qStart.add(2, 'month').endOf('month');
  const cycle = await upsertByName(PerformanceCycle, { companyId: acme._id, name: `Q${qIdx + 1} ${dayjs().year()} Performance Review` }, {
    startDate: qStart.toDate(),
    endDate: qEnd.toDate(),
    status: 'open',
    description: 'Quarterly performance check-in for all confirmed employees',
  });
  await upsertByName(PerformanceReview, { companyId: acme._id, cycleId: cycle._id, employeeId: johnEmp._id }, {
    selfReview: { submittedBy: johnUser._id, rating: 4, ratings: { delivery: 4, ownership: 4, teamwork: 5 }, comments: 'Closed all operations tickets within SLA this quarter.', submittedAt: dayjs().subtract(6, 'day').toDate() },
    managerReview: { submittedBy: managerUser._id, rating: 4, ratings: { delivery: 4, ownership: 4, teamwork: 4 }, comments: 'Consistent and dependable; ready for bigger client accounts.', submittedAt: dayjs().subtract(3, 'day').toDate() },
    finalRating: 4,
    finalizedBy: adminUser._id,
    finalizedAt: dayjs().subtract(1, 'day').toDate(),
    status: 'finalized',
  });
  await upsertByName(PerformanceReview, { companyId: acme._id, cycleId: cycle._id, employeeId: snehaEmp._id }, {
    selfReview: { submittedBy: snehaUser._id, rating: 4, ratings: { delivery: 4, creativity: 5 }, comments: 'Delivered 3 design projects including the Prestige mock-ups.', submittedAt: dayjs().subtract(2, 'day').toDate() },
    managerReview: null,
    finalRating: null,
    status: 'in_progress',
  });

  const tasks = [
    { title: 'Prepare June client review deck', assignedTo: johnEmp._id, assignedBy: managerUser._id, dueDate: dayjs().add(2, 'day').toDate(), priority: 'high', status: 'in_progress' },
    { title: 'Reconcile May vendor invoices', assignedTo: arjunEmp._id, assignedBy: adminUser._id, dueDate: dayjs().add(4, 'day').toDate(), priority: 'medium', status: 'todo' },
    { title: 'Update field visit SOP document', assignedTo: fieldEmp._id, assignedBy: managerUser._id, dueDate: dayjs().add(7, 'day').toDate(), priority: 'low', status: 'on_hold' },
    { title: 'Submit Prestige Estates mood boards', assignedTo: divyaEmp._id, assignedBy: adminUser._id, dueDate: dayjs().subtract(2, 'day').toDate(), priority: 'high', status: 'completed', completedAt: dayjs().subtract(2, 'day').toDate() },
    { title: 'Audit office stationery stock', assignedTo: rohanEmp._id, assignedBy: managerUser._id, dueDate: dayjs().subtract(5, 'day').toDate(), priority: 'low', status: 'cancelled' },
    { title: 'Plan Bengaluru office layout refresh', assignedTo: snehaEmp._id, assignedBy: managerUser._id, dueDate: dayjs().add(10, 'day').toDate(), priority: 'medium', status: 'todo' },
  ];
  for (const t of tasks) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Task, { companyId: acme._id, title: t.title }, { ...t, description: t.title });
  }

  const assets = [
    { code: 'AST-001', name: 'Dell Latitude 5440', category: 'laptop', serialNumber: 'DL5440-88321', purchaseDate: dayjs().subtract(10, 'month').toDate(), value: 78000, condition: 'good', status: 'assigned', assignedTo: johnEmp._id, assignmentHistory: [{ employeeId: johnEmp._id, assignedBy: adminUser._id, assignedAt: dayjs().subtract(9, 'month').toDate(), note: 'Issued at onboarding refresh' }] },
    { code: 'AST-002', name: 'MacBook Air M2', category: 'laptop', serialNumber: 'MBA-M2-44109', purchaseDate: dayjs().subtract(7, 'month').toDate(), value: 114000, condition: 'good', status: 'assigned', assignedTo: divyaEmp._id, assignmentHistory: [{ employeeId: divyaEmp._id, assignedBy: adminUser._id, assignedAt: dayjs().subtract(6, 'month').toDate(), note: 'Design team machine' }] },
    { code: 'AST-003', name: 'Samsung Galaxy M14', category: 'mobile', serialNumber: 'SGM14-20991', purchaseDate: dayjs().subtract(5, 'month').toDate(), value: 14000, condition: 'good', status: 'assigned', assignedTo: fieldEmp._id, assignmentHistory: [{ employeeId: fieldEmp._id, assignedBy: managerUser._id, assignedAt: dayjs().subtract(5, 'month').toDate(), note: 'Field tracking handset' }] },
    { code: 'AST-004', name: 'Airtel postpaid SIM (field pool)', category: 'sim', serialNumber: 'ATL-98220-11', purchaseDate: dayjs().subtract(5, 'month').toDate(), value: 0, condition: 'good', status: 'available' },
    { code: 'AST-005', name: 'Honda Activa 6G', category: 'vehicle', serialNumber: 'MH02-FZ-5521', purchaseDate: dayjs().subtract(2, 'year').toDate(), value: 82000, condition: 'needs service', status: 'in_repair' },
    { code: 'AST-006', name: 'Bosch site toolkit', category: 'tools', serialNumber: 'BSH-TK-3318', purchaseDate: dayjs().subtract(1, 'year').toDate(), value: 26000, condition: 'good', status: 'available' },
  ];
  for (const a of assets) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Asset, { companyId: acme._id, code: a.code }, a);
  }

  const docs = [
    { employeeId: johnEmp._id, type: 'aadhaar', title: 'Aadhaar Card — John Doe', status: 'verified', verifiedBy: hrUser._id, verifiedAt: dayjs().subtract(20, 'day').toDate(), uploadedBy: johnUser._id },
    { employeeId: johnEmp._id, type: 'pan', title: 'PAN Card — John Doe', status: 'pending', uploadedBy: johnUser._id },
    { employeeId: divyaEmp._id, type: 'photo', title: 'Passport Photo — Divya Sharma', status: 'verified', verifiedBy: hrUser._id, verifiedAt: dayjs().subtract(10, 'day').toDate(), uploadedBy: divyaUser._id },
    { employeeId: arjunEmp._id, type: 'bank', title: 'Cancelled Cheque — Arjun Nair', status: 'pending', uploadedBy: arjunUser._id },
  ];
  for (const d of docs) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(EmployeeDocument, { companyId: acme._id, employeeId: d.employeeId, title: d.title }, {
      ...d, fileUrl: '/uploads/placeholder.pdf', fileName: 'placeholder.pdf',
    });
  }
  console.log('  ✔ 2 jobs + 6 candidates, 1 performance cycle + 2 reviews, 6 tasks, 6 assets, 4 employee documents');

  // ==========================================================================
  // 22. Comms & support — announcements, tickets, resignation, feature
  //     requests, notifications
  // ==========================================================================
  await upsertByName(Announcement, { companyId: acme._id, title: 'Revised Leave Policy effective this month' }, {
    message: 'Earned leave can now be carried forward up to 15 days. Casual leave requests need 2 working days notice. See the HR handbook for details.',
    audience: 'all', publishedBy: adminUser._id, publishAt: dayjs().subtract(3, 'day').toDate(), isActive: true,
  });
  await upsertByName(Announcement, { companyId: acme._id, title: 'Holiday Notice: Upcoming public holidays' }, {
    message: 'Offices remain closed on Gandhi Jayanti (2 Oct), Diwali (8 Nov) and Christmas (25 Dec). Field teams on duty get compensatory off.',
    audience: 'all', publishedBy: hrUser._id, publishAt: dayjs().subtract(1, 'day').toDate(), isActive: true,
  });
  await upsertByName(Announcement, { companyId: acme._id, title: 'Birthday wishes to our Design lead!' }, {
    message: 'Join us in wishing Divya Sharma a very happy birthday this week. Cake at the Bengaluru office pantry, 4 PM!',
    audience: 'all', publishedBy: hrUser._id, publishAt: dayjs().toDate(), expiresAt: dayjs().add(7, 'day').toDate(), isActive: true,
  });
  await upsertByName(Announcement, { companyId: acme._id, title: 'Field staff: check-in guidelines' }, {
    message: 'Always check in within the client geo-fence and capture a selfie. Outside check-ins need manager approval with a reason. Keep location ON during work hours.',
    audience: 'all', publishedBy: managerUser._id, publishAt: dayjs().subtract(2, 'day').toDate(), isActive: true,
  });

  const tickets = [
    { ticketNumber: 'TKT-00001', employeeId: johnEmp._id, raisedBy: johnUser._id, category: 'it', subject: 'Laptop running very slow', description: 'Dell Latitude takes 10+ minutes to boot and hangs on Excel.', priority: 'high', status: 'open',
      comments: [
        { by: johnUser._id, byName: 'John Doe', message: 'It started after the last Windows update.', at: dayjs().subtract(1, 'day').toDate() },
        { by: adminUser._id, byName: 'Acme Admin', message: 'IT vendor visit scheduled for tomorrow morning.', at: dayjs().subtract(4, 'hour').toDate() },
      ] },
    { ticketNumber: 'TKT-00002', employeeId: divyaEmp._id, raisedBy: divyaUser._id, category: 'hr', subject: 'Name spelling wrong on insurance card', description: 'Group medical card shows "Diviya" instead of "Divya".', priority: 'medium', status: 'in_progress', assignedTo: hrUser._id,
      comments: [
        { by: hrUser._id, byName: 'Hina HR', message: 'Raised with the insurer, corrected card expected in 5 working days.', at: dayjs().subtract(2, 'day').toDate() },
      ] },
    { ticketNumber: 'TKT-00003', employeeId: fieldEmp._id, raisedBy: fieldUser._id, category: 'payroll', subject: 'Travel allowance missing for last month', description: 'KM allowance for last month shows zero despite logged routes.', priority: 'medium', status: 'waiting_for_employee', assignedTo: payrollUser._id },
    { ticketNumber: 'TKT-00004', employeeId: arjunEmp._id, raisedBy: arjunUser._id, category: 'admin', subject: 'Need parking sticker for new vehicle', description: 'Replaced two-wheeler; need a new society parking sticker.', priority: 'low', status: 'resolved', resolvedAt: dayjs().subtract(1, 'day').toDate() },
    { ticketNumber: 'TKT-00005', employeeId: snehaEmp._id, raisedBy: snehaUser._id, category: 'other', subject: 'Evening shift cab drop request', description: 'Requesting cab drop after 11 PM shift end for Bengaluru office.', priority: 'medium', status: 'closed', resolvedAt: dayjs().subtract(4, 'day').toDate(), closedAt: dayjs().subtract(3, 'day').toDate() },
  ];
  for (const t of tickets) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Ticket, { companyId: acme._id, ticketNumber: t.ticketNumber }, t);
  }

  // resignation in checklist stage for a non-critical employee
  await upsertByName(Resignation, { companyId: acme._id, employeeId: ananyaEmp._id }, {
    reason: 'Relocating to Kolkata for family reasons',
    resignationDate: dayjs().subtract(20, 'day').toDate(),
    noticePeriodDays: 30,
    lastWorkingDate: dayjs().add(10, 'day').toDate(),
    status: 'checklist_in_progress',
    managerActionBy: managerUser._id,
    managerActionAt: dayjs().subtract(18, 'day').toDate(),
    managerNote: 'Approved; handover plan shared with Accounts',
    hrActionBy: hrUser._id,
    hrActionAt: dayjs().subtract(15, 'day').toDate(),
    hrNote: 'Notice period confirmed till last working date',
    checklist: [
      { item: 'Assets returned', done: true },
      { item: 'Full & final settled', done: false },
      { item: 'Exit interview done', done: true },
      { item: 'Access revoked', done: false },
      { item: 'Documents handed over', done: false },
    ],
  });

  await upsertByName(FeatureRequest, { companyId: acme._id, title: 'WhatsApp notifications for leave approvals' }, {
    description: 'Send WhatsApp alerts to employees when their leave is approved or rejected, in addition to in-app notifications.',
    featureKey: 'whatsappNotification',
    status: 'under_review',
    requestedBy: adminUser._id,
    statusHistory: [
      { status: 'requested', by: adminUser._id, at: dayjs().subtract(6, 'day').toDate() },
      { status: 'under_review', at: dayjs().subtract(4, 'day').toDate(), note: 'Scoping WhatsApp Business API costs' },
    ],
  });
  await upsertByName(FeatureRequest, { companyId: acme._id, title: 'Custom branded payslip PDF' }, {
    description: 'Payslip PDFs with Acme logo, brand colours and CTC annexure for senior staff.',
    status: 'quotation_sent',
    requestedBy: adminUser._id,
    quoteAmount: 45000,
    estimatedDays: 15,
    statusHistory: [
      { status: 'requested', by: adminUser._id, at: dayjs().subtract(12, 'day').toDate() },
      { status: 'under_review', at: dayjs().subtract(10, 'day').toDate() },
      { status: 'quotation_sent', at: dayjs().subtract(7, 'day').toDate(), note: 'Quote shared: ₹45,000 / 15 days' },
    ],
  });

  const notifs = [
    { userId: adminUser._id, title: 'Leave request pending approval', message: 'Kavya Reddy requested 4 days casual leave starting next week.', type: 'leave', isRead: false },
    { userId: adminUser._id, title: 'New support ticket raised', message: 'TKT-00001: Laptop running very slow (it)', type: 'ticket', isRead: false },
    { userId: fieldUser._id, title: 'New work assignment for today', message: 'Product demo & installation at Globex Retail, 10:00 AM.', type: 'assignment', isRead: false },
    { userId: fieldUser._id, title: 'Salary credited', message: `Your salary for ${payMonthRef.format('MMMM YYYY')} has been processed.`, type: 'payroll', isRead: true, readAt: dayjs().subtract(2, 'day').toDate() },
    { userId: fieldUser._id, title: 'New announcement', message: 'Field staff: check-in guidelines — please read before your next visit.', type: 'announcement', isRead: false },
  ];
  for (const n of notifs) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Notification, { userId: n.userId, title: n.title }, { ...n, companyId: acme._id });
  }
  console.log('  ✔ 4 announcements, 5 tickets, 1 resignation (checklist), 2 feature requests, 5 notifications');

  // ==========================================================================
  // 22b. TODAY pack — fills every live/today view (dashboard attendanceToday,
  //      fieldToday, /field/locations/live, Live Tracking map).
  //      Idempotent per day: attendance upserts by {companyId, employeeId, date},
  //      assignments/visits by stable keys, today's GPS trail replaced wholesale.
  //      NOTE: field@acme.com's two original today-assignments (section 7) are
  //      not touched here and stay 'assigned' — the e2e suite depends on them.
  // ==========================================================================
  const todayDate = today();
  const now = dayjs();

  // a previous day's seed run leaves a stale "live" visit — close it out so
  // only today's seeded visit is active
  const staleVisits = await FieldVisit.find({ companyId: acme._id, status: 'checked_in', date: { $lt: todayDate } });
  for (const v of staleVisits) {
    v.checkOutTime = dayjs(`${v.date} 18:00`).toDate();
    v.checkOutLocation = v.checkInLocation;
    v.totalWorkMinutes = v.checkInTime ? Math.max(Math.round((v.checkOutTime - v.checkInTime) / 60000), 0) : 0;
    v.status = 'checked_out';
    // eslint-disable-next-line no-await-in-loop
    await v.save();
    // eslint-disable-next-line no-await-in-loop
    await FieldWorkAssignment.updateOne(
      { _id: v.workAssignmentId, status: 'checked_in' },
      { $set: { status: 'completed' }, $push: { statusHistory: { status: 'completed', at: v.checkOutTime } } }
    );
  }

  // --- (a) TODAY attendance for all active employees ------------------------
  // Kavya (live visit) & Vikrant (completed visit) get field_visit-derived rows
  // in (b)/(c). Shift starts 09:30 (+15m grace): 2 late, 1 wfh, 1 absent,
  // 1 on_leave, rest present. Only ~3 early leavers have checked out today —
  // everyone else is still working (checkOut null).
  const todayPlan = [
    { emp: managerEmp, in: '09:12', source: 'web' },
    { emp: hrEmp, in: '09:18', source: 'web' },
    { emp: fieldEmp, in: '09:24', source: 'employee_app' },
    { emp: payrollEmp, in: '09:21', out: '13:35', source: 'web' }, // early leaver
    { emp: divyaEmp, in: '09:33', out: '14:10', source: 'employee_app' }, // early leaver
    { emp: johnEmp, in: '09:52', status: 'late', lateMinutes: 22, source: 'web' },
    { emp: arjunEmp, in: '10:05', status: 'late', lateMinutes: 35, out: '14:05', source: 'employee_app' }, // early leaver
    { emp: snehaEmp, in: '10:02', status: 'wfh', source: 'employee_app' },
    { emp: ananyaEmp, status: 'absent' },
    { emp: rohanEmp, in: '09:41', source: 'web' },
  ];
  // on_leave: reuse an approved leave spanning today when one exists, else mark Rohan
  const leaveSpanningToday = await Leave.findOne({
    companyId: acme._id,
    status: 'approved',
    fromDate: { $lte: todayDate },
    toDate: { $gte: todayDate },
    employeeId: { $in: todayPlan.map((p) => p.emp._id) },
  }).lean();
  const onLeaveEmpId = String(leaveSpanningToday ? leaveSpanningToday.employeeId : rohanEmp._id);

  const todayRow = (emp, { status = 'present', inTime, outTime, source = 'web', lateMinutes = 0 }) => {
    const set = { shiftId: emp.job.shiftId, status, attendanceSource: source, lateMinutes, earlyExitMinutes: 0 };
    if (status === 'absent' || status === 'on_leave' || !inTime) {
      Object.assign(set, { checkIn: null, checkOut: null, workMinutes: 0, totalHours: 0 });
    } else {
      const checkIn = dayjs(`${todayDate} ${inTime}`).toDate();
      const checkOut = outTime ? dayjs(`${todayDate} ${outTime}`).toDate() : null;
      const workMinutes = checkOut ? Math.round((checkOut - checkIn) / 60000) : 0;
      Object.assign(set, {
        checkIn: { time: checkIn, source },
        checkOut: checkOut ? { time: checkOut, source } : null,
        workMinutes,
        totalHours: Math.round((workMinutes / 60) * 100) / 100,
      });
    }
    return { updateOne: { filter: { companyId: acme._id, employeeId: emp._id, date: todayDate }, update: { $set: set }, upsert: true } };
  };

  const todayOps = todayPlan.map((p) => {
    const onLeave = String(p.emp._id) === onLeaveEmpId;
    return todayRow(p.emp, {
      status: onLeave ? 'on_leave' : (p.status || 'present'),
      inTime: onLeave ? null : p.in,
      outTime: onLeave ? null : p.out,
      source: p.source,
      lateMinutes: onLeave ? 0 : (p.lateMinutes || 0),
    });
  });
  // active employees created outside the seed also get a present row (still working)
  const coveredIds = [...todayPlan.map((p) => p.emp._id), kavyaEmp._id, vikrantEmp._id];
  const strayEmps = await Employee.find({
    companyId: acme._id, isDeleted: false, status: 'active', _id: { $nin: coveredIds },
  }).select('job.shiftId').lean();
  strayEmps.forEach((emp, i) => {
    todayOps.push(todayRow(emp, { inTime: `09:${16 + (i % 4) * 7}`, source: i % 2 ? 'employee_app' : 'web' }));
  });
  await Attendance.bulkWrite(todayOps);

  // --- (b) Kavya is checked in at Prestige Estates RIGHT NOW ----------------
  // checked_in assignment + live FieldVisit + GPS trail over the last 2h →
  // /field/locations/live shows a marker and fieldToday.activeVisits >= 1
  const liveCheckIn = now.subtract(2, 'hour');
  const prestigeGeo = { latitude: clientPrestige.location.latitude, longitude: clientPrestige.location.longitude, accuracy: 8, address: clientPrestige.address };
  const asgKavyaLive = await upsertAssignment(kavyaEmp._id, 'Modular kitchen final measurement', todayDate, {
    clientId: clientPrestige._id,
    clientLocation: { latitude: clientPrestige.location.latitude, longitude: clientPrestige.location.longitude, address: clientPrestige.address },
    description: 'Final on-site measurement before modular kitchen production',
    startTime: liveCheckIn.format('HH:mm'),
    endTime: liveCheckIn.add(4, 'hour').format('HH:mm'),
    priority: 'high',
    status: 'checked_in',
    checklist: [
      { label: 'Verify kitchen wall dimensions', completed: true, completedAt: liveCheckIn.add(50, 'minute').toDate() },
      { label: 'Confirm appliance cutout sizes', completed: false },
    ],
    statusHistory: [
      { status: 'assigned', by: managerUser._id, at: liveCheckIn.subtract(90, 'minute').toDate() },
      { status: 'on_the_way', by: kavyaUser._id, at: liveCheckIn.subtract(40, 'minute').toDate() },
      { status: 'reached', by: kavyaUser._id, at: liveCheckIn.subtract(4, 'minute').toDate() },
      { status: 'checked_in', by: kavyaUser._id, at: liveCheckIn.toDate() },
    ],
  });
  await upsertByName(FieldVisit, { companyId: acme._id, workAssignmentId: asgKavyaLive._id, date: todayDate }, {
    employeeId: kavyaEmp._id,
    clientId: clientPrestige._id,
    checkInTime: liveCheckIn.toDate(),
    checkInLocation: prestigeGeo,
    checkOutTime: null,
    checkOutLocation: null,
    totalWorkMinutes: 0,
    distanceMeters: 4,
    status: 'checked_in',
    approvalStatus: 'none',
    proofStatus: null,
  });
  // replace today's GPS trail: 4 points over the last 2h, newest ~5 minutes old
  await FieldLocationLog.deleteMany({
    companyId: acme._id,
    employeeId: kavyaEmp._id,
    capturedAt: { $gte: dayjs(todayDate).startOf('day').toDate() },
  });
  const drift = [[0, 0], [0.0005, 0.0003], [-0.0004, 0.0005], [0.0002, -0.0002]];
  await FieldLocationLog.insertMany([120, 80, 40, 5].map((minsAgo, i) => ({
    companyId: acme._id,
    employeeId: kavyaEmp._id,
    workAssignmentId: asgKavyaLive._id,
    latitude: Math.round((clientPrestige.location.latitude + drift[i][0]) * 1e6) / 1e6,
    longitude: Math.round((clientPrestige.location.longitude + drift[i][1]) * 1e6) / 1e6,
    accuracy: 10,
    capturedAt: now.subtract(minsAgo, 'minute').toDate(),
    batteryLevel: 91 - i * 6,
    trackingType: i === 0 ? 'checkin' : 'interval',
  })));
  // attendance derived from the live visit via the real service (no checkout yet)
  await upsertDayAttendance(acme._id, kavyaEmp._id, todayDate);

  // --- (c) Vikrant completed a visit earlier today ---------------------------
  // → "Visits completed today" >= 1. Single-day job finished today, so the
  // assignment ends 'completed' (a multi-day checkout would go back to 'in_progress').
  const doneCheckIn = dayjs(`${todayDate} 09:35`);
  let doneCheckOut = now.subtract(30, 'minute');
  if (!doneCheckOut.isAfter(doneCheckIn)) doneCheckOut = doneCheckIn.add(45, 'minute'); // guard for early-morning seed runs
  const doneMinutes = Math.max(doneCheckOut.diff(doneCheckIn, 'minute'), 1);
  const globexGeo = { latitude: client1.location.latitude, longitude: client1.location.longitude, accuracy: 9, address: client1.address };
  const asgVikrantDone = await upsertAssignment(vikrantEmp._id, 'Snag-list verification walkthrough', todayDate, {
    clientId: client1._id,
    clientLocation: { latitude: client1.location.latitude, longitude: client1.location.longitude, address: client1.address },
    description: 'Verify and close the pending snag list at the Globex store',
    startTime: '09:30',
    endTime: '13:30',
    priority: 'medium',
    status: 'completed',
    checklist: [
      { label: 'Re-test flagged power points', completed: true, completedAt: doneCheckIn.add(1, 'hour').toDate() },
      { label: 'Client sign-off on snag list', completed: true, completedAt: doneCheckOut.subtract(10, 'minute').toDate() },
    ],
    statusHistory: [
      { status: 'assigned', by: managerUser._id, at: dayjs(`${todayDate} 08:30`).toDate() },
      { status: 'on_the_way', by: vikrantEmp.userId, at: dayjs(`${todayDate} 09:05`).toDate() },
      { status: 'reached', by: vikrantEmp.userId, at: dayjs(`${todayDate} 09:30`).toDate() },
      { status: 'checked_in', by: vikrantEmp.userId, at: doneCheckIn.toDate() },
      { status: 'in_progress', by: vikrantEmp.userId, at: dayjs(`${todayDate} 09:45`).toDate() },
      { status: 'completed', by: vikrantEmp.userId, at: doneCheckOut.toDate() },
    ],
  });
  await upsertByName(FieldVisit, { companyId: acme._id, workAssignmentId: asgVikrantDone._id, date: todayDate }, {
    employeeId: vikrantEmp._id,
    clientId: client1._id,
    checkInTime: doneCheckIn.toDate(),
    checkInLocation: globexGeo,
    checkOutTime: doneCheckOut.toDate(),
    checkOutLocation: globexGeo,
    remarks: 'Snag list verified and signed off by the client',
    totalWorkMinutes: doneMinutes,
    distanceMeters: 6,
    status: 'checked_out',
    approvalStatus: 'none',
    proofStatus: 'submitted',
  });
  await upsertDayAttendance(acme._id, vikrantEmp._id, todayDate);
  console.log(`  ✔ TODAY pack (${todayDate}): attendance × ${todayOps.length + 2} (2 late, 1 wfh, 1 absent, 1 on_leave, 3 early checkouts), Kavya live at Prestige Estates (4 GPS pts), Vikrant completed 1 visit`);

  // ==========================================================================
  // 22c. HR Extensions v1.2 — project + timesheets, policies + acks, training
  // ==========================================================================
  const project = await upsertByName(Project, { companyId: acme._id, name: 'Prestige Villa Interiors' }, {
    code: 'PRJ-001',
    clientId: clientPrestige._id,
    description: 'Turnkey interior fit-out of the Prestige model villa — design, civil and execution',
    status: 'active',
    startDate: dayjs().subtract(1, 'month').toDate(),
    endDate: dayjs().add(2, 'month').toDate(),
    managerId: managerEmp._id,
    members: [fieldEmp._id, kavyaEmp._id, vikrantEmp._id, divyaEmp._id, snehaEmp._id],
  });

  // 2 project-linked tasks
  await upsertByName(Task, { companyId: acme._id, title: 'Finalize villa false-ceiling drawings' }, {
    description: 'Finalize villa false-ceiling drawings',
    projectId: project._id,
    assignedTo: divyaEmp._id,
    assignedBy: managerUser._id,
    dueDate: dayjs().add(3, 'day').toDate(),
    priority: 'high',
    status: 'in_progress',
  });
  await upsertByName(Task, { companyId: acme._id, title: 'Procure villa site material — phase 1' }, {
    description: 'Procure villa site material — phase 1',
    projectId: project._id,
    assignedTo: vikrantEmp._id,
    assignedBy: managerUser._id,
    dueDate: dayjs().add(5, 'day').toDate(),
    priority: 'medium',
    status: 'todo',
  });

  // 4 timesheets on the project (2 approved by the manager, 2 awaiting action)
  const timesheets = [
    { employeeId: fieldEmp._id, date: visitDate1, hours: 8, note: 'Site supervision at villa', billable: true, status: 'approved' },
    { employeeId: kavyaEmp._id, date: visitDate1, hours: 6.5, note: 'Modular kitchen measurement & vendor briefing', billable: true, status: 'approved' },
    { employeeId: vikrantEmp._id, date: visitDate2, hours: 7, note: 'Electrical first-fix inspection', billable: false, status: 'submitted' },
    { employeeId: snehaEmp._id, date: visitDate2, hours: 5, note: '3D views for living room options', billable: true, status: 'submitted' },
  ];
  for (const ts of timesheets) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Timesheet, { companyId: acme._id, employeeId: ts.employeeId, projectId: project._id, date: ts.date }, {
      hours: ts.hours,
      note: ts.note,
      billable: ts.billable,
      status: ts.status,
      actionBy: ts.status === 'approved' ? managerUser._id : null,
      actionAt: ts.status === 'approved' ? dayjs(`${ts.date} 19:00`).toDate() : null,
    });
  }

  // 2 HR policies, acknowledged by 3 employees
  const policyLeave = await upsertByName(Policy, { companyId: acme._id, title: 'Leave Policy v1' }, {
    description: 'Casual/sick/earned leave entitlements, approval levels and carry-forward rules',
    fileUrl: '/uploads/placeholder.pdf',
    version: 1,
    active: true,
    createdBy: hrUser._id,
    isDeleted: false,
  });
  const policyConduct = await upsertByName(Policy, { companyId: acme._id, title: 'Code of Conduct' }, {
    description: 'Workplace behaviour, client interaction and data confidentiality guidelines',
    fileUrl: '/uploads/placeholder.pdf',
    version: 1,
    active: true,
    createdBy: hrUser._id,
    isDeleted: false,
  });
  const ackPairs = [
    [policyLeave, johnEmp], [policyLeave, fieldEmp], [policyLeave, divyaEmp],
    [policyConduct, johnEmp], [policyConduct, fieldEmp],
  ];
  for (const [policy, emp] of ackPairs) {
    // eslint-disable-next-line no-await-in-loop
    await PolicyAck.findOneAndUpdate(
      { policyId: policy._id, employeeId: emp._id },
      { $setOnInsert: { companyId: acme._id, acknowledgedAt: dayjs().subtract(2, 'day').toDate() } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  // 2 training courses + assignments for 4 employees (1 completed)
  const courseSafety = await upsertByName(Course, { companyId: acme._id, title: 'Safety Induction' }, {
    type: 'video',
    url: 'https://youtu.be/safety-induction-101',
    description: 'Mandatory on-site safety induction for all field staff',
    durationMinutes: 45,
    active: true,
    createdBy: hrUser._id,
    isDeleted: false,
  });
  const courseSop = await upsertByName(Course, { companyId: acme._id, title: 'HR SOP Handbook' }, {
    type: 'pdf',
    url: '/uploads/placeholder.pdf',
    description: 'Standard operating procedures for HR processes',
    durationMinutes: 30,
    active: true,
    createdBy: hrUser._id,
    isDeleted: false,
  });
  const courseAssignments = [
    { course: courseSafety, emp: fieldEmp, completed: true },
    { course: courseSafety, emp: kavyaEmp, completed: false },
    { course: courseSafety, emp: vikrantEmp, completed: false },
    { course: courseSop, emp: johnEmp, completed: false },
  ];
  for (const a of courseAssignments) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(CourseAssignment, { companyId: acme._id, courseId: a.course._id, employeeId: a.emp._id }, {
      dueDate: dayjs().add(14, 'day').toDate(),
      status: a.completed ? 'completed' : 'assigned',
      completedAt: a.completed ? dayjs().subtract(1, 'day').toDate() : null,
      assignedBy: hrUser._id,
    });
  }
  console.log('  ✔ Project "Prestige Villa Interiors" (2 tasks, 4 timesheets), 2 policies (+5 acks), 2 courses (+4 assignments)');

  // ==========================================================================
  // 23. Second demo company — Globex Interiors on Standard TRIAL
  // ==========================================================================
  const globex = await upsertByName(Company, { code: 'GLOBEX' }, {
    name: 'Globex Interiors',
    email: 'contact@globex-interiors.com',
    phone: '+91-9777700000',
    contactPerson: { name: 'Globex Admin', phone: '+91-9777700000', email: 'admin@globex.com' },
    address: { line1: '7 Residency Road', city: 'Bengaluru', state: 'Karnataka', country: 'India', pincode: '560025' },
    status: 'active',
  });
  await upsertByName(CompanySubscription, { companyId: globex._id, planId: plans.Standard._id }, {
    startDate: dayjs().subtract(4, 'day').toDate(),
    endDate: dayjs().add(10, 'day').toDate(), // trial ends ~10 days from now
    billingCycle: 'trial',
    status: 'trial',
    employeeLimit: plans.Standard.employeeLimit,
    fieldEmployeeLimit: plans.Standard.fieldEmployeeLimit,
    amount: 0,
  });
  await upsertUser({
    name: 'Globex Admin', email: 'admin@globex.com', password: 'Globex@123', role: ROLES.COMPANY_ADMIN, companyId: globex._id,
  });
  const globexEmp1 = await upsertEmployee(globex._id, 'GX0001', {
    personal: { firstName: 'Priya', lastName: 'Menon', email: 'priya@globex-interiors.com', phone: '+91-9777700001', gender: 'female' },
    job: { joiningDate: dayjs().subtract(3, 'day').toDate(), employmentType: 'full_time', employeeType: 'office_employee' },
    salary: { ...salaryBase, ctc: 480000, basic: 20000, hra: 10000 },
    onboardingStatus: 'active',
    status: 'active',
  });
  const globexEmp2 = await upsertEmployee(globex._id, 'GX0002', {
    personal: { firstName: 'Aditya', lastName: 'Rao', email: 'aditya@globex-interiors.com', phone: '+91-9777700002', gender: 'male' },
    job: { joiningDate: dayjs().subtract(2, 'day').toDate(), employmentType: 'full_time', employeeType: 'office_employee' },
    salary: { ...salaryBase, ctc: 420000, basic: 17500, hra: 8750 },
    onboardingStatus: 'active',
    status: 'active',
  });
  await seedLeaveBalance(globex._id, globexEmp1._id);
  await seedLeaveBalance(globex._id, globexEmp2._id);
  console.log('  ✔ Globex Interiors (Standard trial, ends in ~10 days) + admin@globex.com + 2 employees');

  console.log('\nSeed complete.');
  console.log('--------------------------------------------');
  console.log('Logins:');
  console.log('  super_admin   owner@hrms.com    / Owner@123');
  console.log('  company_admin admin@acme.com    / Admin@123');
  console.log('  hr_admin      hr@acme.com       / Hr@12345');
  console.log('  manager       manager@acme.com  / Manager@123');
  console.log('  employee      john@acme.com     / John@123');
  console.log('  field         field@acme.com    / Field@123');
  console.log('  payroll       payroll@acme.com  / Payroll@123');
  console.log('  acme (new)    divya|arjun|kavya|rohan|sneha|vikrant|ananya@acme.com / Temp@1234');
  console.log('  company_admin admin@globex.com  / Globex@123  (Standard trial)');
  process.exit(0);
};

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
