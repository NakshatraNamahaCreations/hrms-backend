/* eslint-disable no-console */
// Optional, idempotent demo-data seed for the existing "NNC" company ONLY.
// Run: npm run seed:nnc  (safe to run repeatedly — upserts by stable keys)
//
// It NEVER touches: the NNC company document (settings/subscription/features),
// the existing employee "jay", the existing client VIJAY HOME SERVICES, jay's
// assignments/visits, or any other company (ACME / Globex / platform data).
require('dotenv').config();
const dayjs = require('dayjs');
const connectDB = require('../src/config/db');

const {
  User,
  Company,
  Employee,
  Branch,
  Department,
  Designation,
  Shift,
  Holiday,
  Attendance,
  Client,
  FieldWorkAssignment,
  FieldVisit,
  FieldLocationLog,
  Leave,
  LeaveBalance,
  Loan,
  Task,
  Asset,
  Announcement,
  Ticket,
} = require('../src/models');
const { ROLES } = require('../src/constants');

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

// next occurrence of a fixed-date holiday ('MM-DD'), this year or next
const upcoming = (monthDay) => {
  let d = dayjs(`${dayjs().year()}-${monthDay}`);
  if (d.isBefore(dayjs(), 'day')) d = d.add(1, 'year');
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

  // --------------------------------------------------------------------------
  // 0. Locate the NNC company — read-only; abort clearly when missing.
  //    Its settings / subscription / features are intentionally NOT modified.
  // --------------------------------------------------------------------------
  const nnc = await Company.findOne({ name: 'NNC' });
  if (!nnc) {
    console.error('ABORT: Company "NNC" not found in this database. Nothing was seeded.');
    process.exit(1);
  }
  console.log(`Seeding NNC demo data (company ${nnc._id})...`);

  // existing company admin (used as assignedBy/publishedBy); user doc untouched
  const adminUser = await User.findOne({ companyId: nnc._id, role: ROLES.COMPANY_ADMIN });

  // --------------------------------------------------------------------------
  // 1. Org setup — Bengaluru HQ branch, Design/Sales depts, 2 designations,
  //    General Shift (created only for NNC; existing "Bengaluru" branch and
  //    "INTIRIOR" department are left as-is)
  // --------------------------------------------------------------------------
  const branchHQ = await upsertByName(Branch, { companyId: nnc._id, name: 'Bengaluru HQ' }, {
    code: 'BLR-HQ', address: 'MG Road, Bengaluru', city: 'Bengaluru',
    location: { latitude: 12.9716, longitude: 77.5946 },
  });
  const deptDesign = await upsertByName(Department, { companyId: nnc._id, name: 'Design' }, { code: 'DSGN' });
  const deptSales = await upsertByName(Department, { companyId: nnc._id, name: 'Sales' }, { code: 'SALES' });
  const desigOpsMgr = await upsertByName(Designation, { companyId: nnc._id, name: 'Operations Manager' }, { level: 3, departmentId: deptDesign._id });
  const desigExec = await upsertByName(Designation, { companyId: nnc._id, name: 'Executive' }, { level: 1, departmentId: deptSales._id });
  let shift = await Shift.findOne({ companyId: nnc._id, name: 'General Shift' });
  if (!shift) {
    shift = await Shift.create({
      companyId: nnc._id, name: 'General Shift',
      startTime: '09:30', endTime: '18:30', graceMinutes: 15, halfDayHours: 4, fullDayHours: 8, weekOffDays: [0],
    });
  }
  console.log('  ✔ Bengaluru HQ branch, Design/Sales departments, 2 designations, General Shift');

  // --------------------------------------------------------------------------
  // 2. 5 demo employees (clearly-dummy names, all logins Temp@1234)
  //    3 office (Ops Manager + HR + 1 exec) + 2 field; hierarchy under Ops Mgr
  // --------------------------------------------------------------------------
  const salaryBase = {
    ctc: 480000, basic: 20000, hra: 10000, conveyance: 1600, medicalAllowance: 1250,
    specialAllowance: 7150, otherAllowances: 0, pfApplicable: true, esiApplicable: false, ptApplicable: true, tdsPercent: 0,
  };
  const jobBase = {
    branchId: branchHQ._id,
    shiftId: shift._id,
    joiningDate: dayjs().subtract(1, 'year').toDate(),
    employmentType: 'full_time',
  };

  const mkEmployee = async ({ code, first, last, email, phone, gender, dob, role, job, salary, field }) => {
    const emp = await upsertEmployee(nnc._id, code, {
      personal: { firstName: first, lastName: last, email, phone, gender, ...(dob ? { dob } : {}) },
      job,
      salary,
      ...(field ? { field } : {}),
      onboardingStatus: 'active',
      status: 'active',
    });
    const user = await upsertUser({ name: `${first} ${last}`, email, password: 'Temp@1234', role, companyId: nnc._id, employeeId: emp._id });
    emp.userId = user._id;
    await emp.save();
    await seedLeaveBalance(nnc._id, emp._id);
    return { emp, user };
  };

  // Operations Manager first (others report to him)
  const { emp: opsEmp, user: opsUser } = await mkEmployee({
    code: 'NNC-D001', first: 'Rajesh', last: 'Demo', email: 'rajesh.demo@nnc.example', phone: '+91-9000100001',
    gender: 'male', dob: new Date('1988-03-14'), role: ROLES.MANAGER,
    job: { ...jobBase, departmentId: deptDesign._id, designationId: desigOpsMgr._id, employeeType: 'office_employee' },
    salary: { ...salaryBase, ctc: 840000, basic: 35000, hra: 17500 },
  });
  const { emp: hrEmp } = await mkEmployee({
    code: 'NNC-D002', first: 'Priya', last: 'Demo', email: 'priya.demo@nnc.example', phone: '+91-9000100002',
    gender: 'female', dob: new Date('1992-11-02'), role: ROLES.HR_ADMIN,
    job: { ...jobBase, departmentId: deptDesign._id, designationId: desigExec._id, managerId: opsEmp._id, employeeType: 'office_employee' },
    salary: { ...salaryBase, ctc: 600000, basic: 25000, hra: 12500 },
  });
  // Birthday in the next 7 days (celebrations widget)
  const { emp: amitEmp, user: amitUser } = await mkEmployee({
    code: 'NNC-D003', first: 'Amit', last: 'Demo', email: 'amit.demo@nnc.example', phone: '+91-9000100003',
    gender: 'male', dob: dayjs().add(4, 'day').year(1996).toDate(), role: ROLES.EMPLOYEE,
    job: { ...jobBase, departmentId: deptDesign._id, designationId: desigExec._id, managerId: opsEmp._id, employeeType: 'office_employee' },
    salary: salaryBase,
  });
  const fieldConfig = { isFieldEmployee: true, vehicleType: 'bike', fieldAllowancePerDay: 150, travelAllowancePerKm: 4, trackingEnabled: true };
  const { emp: sunilEmp, user: sunilUser } = await mkEmployee({
    code: 'NNC-D004', first: 'Sunil', last: 'Demo', email: 'sunil.demo@nnc.example', phone: '+91-9000100004',
    gender: 'male', dob: new Date('1995-07-19'), role: ROLES.FIELD_EMPLOYEE,
    job: { ...jobBase, departmentId: deptSales._id, designationId: desigExec._id, managerId: opsEmp._id, employeeType: 'field_employee' },
    salary: { ...salaryBase, ctc: 420000, basic: 17500, hra: 8750 },
    field: fieldConfig,
  });
  const { emp: kavitaEmp, user: kavitaUser } = await mkEmployee({
    code: 'NNC-D005', first: 'Kavita', last: 'Demo', email: 'kavita.demo@nnc.example', phone: '+91-9000100005',
    gender: 'female', dob: new Date('1997-01-25'), role: ROLES.FIELD_EMPLOYEE,
    job: { ...jobBase, departmentId: deptSales._id, designationId: desigExec._id, managerId: opsEmp._id, employeeType: 'field_employee' },
    salary: { ...salaryBase, ctc: 420000, basic: 17500, hra: 8750 },
    field: fieldConfig,
  });
  const assignerId = adminUser ? adminUser._id : opsUser._id;
  console.log('  ✔ 5 employees NNC-D001–D005 (*.demo@nnc.example / Temp@1234), hierarchy under Rajesh Demo');

  // --------------------------------------------------------------------------
  // 3. Attendance — TODAY (check-in only) + past 7 working days for the 5 demo
  //    employees. jay is skipped (his attendance derives from field visits).
  // --------------------------------------------------------------------------
  const demoEmps = [opsEmp, hrEmp, amitEmp, sunilEmp, kavitaEmp];
  const pastDays = [];
  for (let n = 7; n >= 1; n -= 1) pastDays.push(prevWorking(n).format('YYYY-MM-DD'));

  const attOps = [];
  const pushAtt = (emp, date, status, inTime, outTime, source) => {
    const set = { shiftId: shift._id, status, attendanceSource: source, lateMinutes: status === 'late' ? 22 : 0, earlyExitMinutes: 0 };
    const checkIn = dayjs(`${date} ${inTime}`).toDate();
    if (outTime) {
      const checkOut = dayjs(`${date} ${outTime}`).toDate();
      const workMinutes = Math.round((checkOut - checkIn) / 60000);
      Object.assign(set, {
        checkIn: { time: checkIn, source },
        checkOut: { time: checkOut, source },
        workMinutes,
        totalHours: Math.round((workMinutes / 60) * 100) / 100,
      });
    } else {
      Object.assign(set, { checkIn: { time: checkIn, source }, checkOut: null, workMinutes: 0, totalHours: 0 });
    }
    attOps.push({
      updateOne: {
        filter: { companyId: nnc._id, employeeId: emp._id, date },
        update: { $set: set },
        upsert: true,
      },
    });
  };

  demoEmps.forEach((emp, i) => {
    const isField = emp.job.employeeType === 'field_employee';
    const source = isField ? 'employee_app' : 'web';
    // past 7 working days — deterministic mix of present / late / wfh
    pastDays.forEach((date, j) => {
      const r = (i + j) % 5;
      let status = 'present';
      let inTime = '09:25';
      if (!isField && r === 1) { status = 'late'; inTime = '09:52'; }
      else if (!isField && r === 2) status = 'wfh';
      else if (isField && r === 3) { status = 'late'; inTime = '09:58'; }
      pushAtt(emp, date, status, inTime, '18:35', source);
    });
    // today — checked in, not yet checked out
    const todayStatus = ['present', 'late', 'wfh', 'present', 'present'][i];
    pushAtt(emp, today(), todayStatus, todayStatus === 'late' ? '09:55' : '09:25', null, source);
  });
  await Attendance.bulkWrite(attOps);
  console.log(`  ✔ Attendance: today + ${pastDays.length} past working days × ${demoEmps.length} employees (jay skipped)`);

  // --------------------------------------------------------------------------
  // 4. Clients — 2 more (one geo-tagged); VIJAY HOME SERVICES untouched
  // --------------------------------------------------------------------------
  const clientSapna = await upsertByName(Client, { companyId: nnc._id, name: 'Sapna Electronics (Demo)' }, {
    code: 'NNC-CL-001',
    contactPerson: 'Mahesh Demo',
    phone: '+91-9000200001',
    email: 'mahesh@sapna-demo.example',
    address: 'Koramangala, Bengaluru',
    location: { latitude: 12.9352, longitude: 77.6245 },
    geoFenceRadiusMeters: 250,
  });
  const clientLakshmi = await upsertByName(Client, { companyId: nnc._id, name: 'Lakshmi Furnishings (Demo)' }, {
    code: 'NNC-CL-002',
    contactPerson: 'Lakshmi Demo',
    phone: '+91-9000200002',
    email: 'lakshmi@lakshmi-demo.example',
    address: 'Jayanagar 4th Block, Bengaluru',
  });
  console.log('  ✔ 2 demo clients (Sapna Electronics geo-tagged, Lakshmi Furnishings address-only)');

  // --------------------------------------------------------------------------
  // 5. 4 work assignments — 2 today, 1 tomorrow, 1 past-completed with a
  //    FieldVisit + 6 GPS route points + field_visit attendance
  // --------------------------------------------------------------------------
  const upsertAssignment = (employeeId, title, date, data) =>
    upsertByName(FieldWorkAssignment, { companyId: nnc._id, employeeId, title, date }, { assignedBy: assignerId, ...data });

  await upsertAssignment(sunilEmp._id, 'Showroom display setup (demo)', today(), {
    clientId: clientSapna._id,
    clientLocation: { latitude: clientSapna.location.latitude, longitude: clientSapna.location.longitude, address: clientSapna.address },
    description: 'Set up the festive display unit at the Koramangala showroom',
    startTime: '11:00', endTime: '13:00', priority: 'high', status: 'assigned',
    checklist: [{ label: 'Carry display kit', completed: false }, { label: 'Get sign-off photo', completed: false }],
    statusHistory: [{ status: 'assigned', by: assignerId, at: dayjs().hour(8).minute(30).toDate() }],
  });
  await upsertAssignment(kavitaEmp._id, 'Curtain measurement visit (demo)', today(), {
    clientId: clientLakshmi._id,
    clientLocation: { address: clientLakshmi.address },
    description: 'Measure living-room windows for curtain quotation',
    startTime: '15:00', endTime: '16:30', priority: 'medium', status: 'on_the_way',
    checklist: [{ label: 'Carry measurement tape & catalogue', completed: true, completedAt: dayjs().hour(10).toDate() }],
    statusHistory: [
      { status: 'assigned', by: assignerId, at: dayjs().hour(9).toDate() },
      { status: 'on_the_way', by: kavitaUser._id, at: dayjs().hour(10).minute(15).toDate() },
    ],
  });
  await upsertAssignment(sunilEmp._id, 'AMC follow-up meeting (demo)', dayjs().add(1, 'day').format('YYYY-MM-DD'), {
    clientId: clientSapna._id,
    clientLocation: { latitude: clientSapna.location.latitude, longitude: clientSapna.location.longitude, address: clientSapna.address },
    description: 'Discuss annual maintenance contract renewal',
    startTime: '10:30', endTime: '11:30', priority: 'medium', status: 'assigned',
    checklist: [{ label: 'Carry AMC draft', completed: false }],
    statusHistory: [{ status: 'assigned', by: assignerId }],
  });

  // past, fully completed assignment + visit (Kavita, 2 working days back)
  const visitDate = prevWorking(2).format('YYYY-MM-DD');
  const asgPast = await upsertAssignment(kavitaEmp._id, 'Sofa fabric sample delivery (demo)', visitDate, {
    clientId: clientSapna._id,
    clientLocation: { latitude: clientSapna.location.latitude, longitude: clientSapna.location.longitude, address: clientSapna.address },
    description: 'Deliver fabric swatches and collect shortlist',
    startTime: '10:00', endTime: '17:00', priority: 'high', status: 'checked_out',
    checklist: [
      { label: 'Hand over swatch box', completed: true, completedAt: dayjs(`${visitDate} 10:30`).toDate() },
      { label: 'Collect shortlisted codes', completed: true, completedAt: dayjs(`${visitDate} 16:30`).toDate() },
    ],
    statusHistory: [
      { status: 'assigned', by: assignerId, at: dayjs(`${visitDate} 08:00`).toDate() },
      { status: 'on_the_way', by: kavitaUser._id, at: dayjs(`${visitDate} 09:10`).toDate() },
      { status: 'reached', by: kavitaUser._id, at: dayjs(`${visitDate} 09:40`).toDate() },
      { status: 'checked_in', by: kavitaUser._id, at: dayjs(`${visitDate} 09:45`).toDate() },
      { status: 'in_progress', by: kavitaUser._id, at: dayjs(`${visitDate} 09:50`).toDate() },
      { status: 'completed', by: kavitaUser._id, at: dayjs(`${visitDate} 17:05`).toDate() },
      { status: 'checked_out', by: kavitaUser._id, at: dayjs(`${visitDate} 17:15`).toDate() },
    ],
  });

  const checkInTime = dayjs(`${visitDate} 09:45`).toDate();
  const checkOutTime = dayjs(`${visitDate} 17:15`).toDate();
  const visitLoc = { latitude: clientSapna.location.latitude, longitude: clientSapna.location.longitude, accuracy: 8, address: clientSapna.address };
  await upsertByName(FieldVisit, { companyId: nnc._id, workAssignmentId: asgPast._id, date: visitDate }, {
    employeeId: kavitaEmp._id,
    clientId: clientSapna._id,
    checkInTime,
    checkInLocation: visitLoc,
    checkOutTime,
    checkOutLocation: visitLoc,
    remarks: 'Samples delivered, shortlist collected from client',
    totalWorkMinutes: 450,
    distanceMeters: 4,
    status: 'checked_out',
    approvalStatus: 'none',
    proofStatus: 'submitted',
  });

  // 6 GPS route points: Bengaluru HQ → client, then around the client site
  const routeTimes = ['09:15', '09:45', '11:30', '13:30', '15:30', '17:15'];
  const gpsOps = routeTimes.map((t, i) => {
    const ratio = Math.min(i / 1, 1); // at the client from the 2nd point onward
    const latitude = branchHQ.location.latitude + (clientSapna.location.latitude - branchHQ.location.latitude) * ratio + (i > 1 ? 0.0004 * (i % 2) : 0);
    const longitude = branchHQ.location.longitude + (clientSapna.location.longitude - branchHQ.location.longitude) * ratio + (i > 1 ? 0.0003 * ((i + 1) % 2) : 0);
    const trackingType = t === '09:45' ? 'checkin' : t === '17:15' ? 'checkout' : 'interval';
    return {
      updateOne: {
        filter: { companyId: nnc._id, employeeId: kavitaEmp._id, capturedAt: dayjs(`${visitDate} ${t}`).toDate() },
        update: {
          $set: {
            workAssignmentId: asgPast._id,
            latitude: Math.round(latitude * 1e6) / 1e6,
            longitude: Math.round(longitude * 1e6) / 1e6,
            accuracy: 10,
            batteryLevel: 95 - i * 9,
            trackingType,
          },
        },
        upsert: true,
      },
    };
  });
  await FieldLocationLog.bulkWrite(gpsOps);

  // visit-derived attendance row (overwrites the generic row for that date)
  await Attendance.findOneAndUpdate(
    { companyId: nnc._id, employeeId: kavitaEmp._id, date: visitDate },
    {
      $set: {
        shiftId: shift._id,
        status: 'present',
        attendanceSource: 'field_visit',
        checkIn: { time: checkInTime, location: { latitude: visitLoc.latitude, longitude: visitLoc.longitude }, source: 'field_visit' },
        checkOut: { time: checkOutTime, location: { latitude: visitLoc.latitude, longitude: visitLoc.longitude }, source: 'field_visit' },
        workMinutes: 450,
        totalHours: 7.5,
        lateMinutes: 0,
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
  console.log('  ✔ 4 work assignments (2 today / 1 tomorrow / 1 past-completed) + FieldVisit + 6 GPS points + field_visit attendance');

  // --------------------------------------------------------------------------
  // 7. 1 disbursed loan for an office employee
  // --------------------------------------------------------------------------
  await upsertByName(Loan, { companyId: nnc._id, employeeId: amitEmp._id, reason: 'Two-wheeler purchase loan (demo)' }, {
    type: 'loan',
    amount: 25000,
    emiAmount: 5000,
    totalEmis: 5,
    paidEmis: 0,
    balance: 25000,
    status: 'disbursed',
    approvedBy: assignerId,
    approvedAt: dayjs().subtract(6, 'day').toDate(),
    disbursedAt: dayjs().subtract(5, 'day').toDate(),
  });
  console.log('  ✔ 1 disbursed loan (Amit Demo)');

  // --------------------------------------------------------------------------
  // 8. 3 leave requests — pending / approved / rejected
  // --------------------------------------------------------------------------
  await upsertByName(Leave, { companyId: nnc._id, employeeId: amitEmp._id, fromDate: dayjs().add(5, 'day').format('YYYY-MM-DD') }, {
    leaveType: 'casual',
    toDate: dayjs().add(6, 'day').format('YYYY-MM-DD'),
    days: 2,
    reason: 'Family function in hometown',
    status: 'pending',
  });
  // approved sick leave 9 working days back (outside the seeded attendance window)
  const approvedLeaveDate = prevWorking(9).format('YYYY-MM-DD');
  const existingApproved = await Leave.findOne({ companyId: nnc._id, employeeId: sunilEmp._id, fromDate: approvedLeaveDate });
  if (!existingApproved) {
    await Leave.create({
      companyId: nnc._id,
      employeeId: sunilEmp._id,
      leaveType: 'sick',
      fromDate: approvedLeaveDate,
      toDate: approvedLeaveDate,
      days: 1,
      reason: 'Fever and rest advised',
      status: 'approved',
      approvedBy: opsUser._id,
      approvedAt: dayjs(approvedLeaveDate).subtract(1, 'day').toDate(),
    });
    const bal = await LeaveBalance.findOne({ companyId: nnc._id, employeeId: sunilEmp._id, year: dayjs().year() });
    if (bal) {
      bal.balances.sick.used = (bal.balances.sick.used || 0) + 1;
      bal.markModified('balances');
      await bal.save();
    }
  }
  await upsertByName(Leave, { companyId: nnc._id, employeeId: kavitaEmp._id, fromDate: dayjs().add(10, 'day').format('YYYY-MM-DD') }, {
    leaveType: 'casual',
    toDate: dayjs().add(10, 'day').format('YYYY-MM-DD'),
    days: 1,
    reason: 'Personal errand',
    status: 'rejected',
    approvedBy: opsUser._id,
    approvedAt: dayjs().subtract(1, 'day').toDate(),
    rejectionReason: 'Client visit already scheduled that day — please reschedule',
  });
  console.log('  ✔ 3 leave requests (pending / approved / rejected)');

  // --------------------------------------------------------------------------
  // 9. 2 announcements, 2 tickets, 3 tasks, 3 assets (1 assigned), 2 holidays
  // --------------------------------------------------------------------------
  const publisherId = adminUser ? adminUser._id : opsUser._id;
  await upsertByName(Announcement, { companyId: nnc._id, title: 'Monthly team huddle this Friday (Demo)' }, {
    message: 'All-hands huddle at Bengaluru HQ this Friday 4 PM. Field team can join on call. Samosas and chai after!',
    audience: 'all', publishedBy: publisherId, publishAt: dayjs().subtract(1, 'day').toDate(), isActive: true,
  });
  await upsertByName(Announcement, { companyId: nnc._id, title: 'Field staff: geo check-in reminder (Demo)' }, {
    message: 'Please check in within the client geo-fence and keep location ON during work hours. Outside check-ins need a reason.',
    audience: 'all', publishedBy: publisherId, publishAt: dayjs().subtract(2, 'day').toDate(), isActive: true,
  });

  const tickets = [
    {
      ticketNumber: 'NNC-TKT-0001', employeeId: amitEmp._id, raisedBy: amitUser._id, category: 'it',
      subject: 'Need design software licence', description: 'Requesting a SketchUp licence for the new project work.',
      priority: 'medium', status: 'open',
    },
    {
      ticketNumber: 'NNC-TKT-0002', employeeId: sunilEmp._id, raisedBy: sunilUser._id, category: 'payroll',
      subject: 'Field allowance query for last month', description: 'Field allowance days look short by two days in last payout.',
      priority: 'medium', status: 'resolved', resolvedAt: dayjs().subtract(1, 'day').toDate(),
    },
  ];
  for (const t of tickets) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Ticket, { companyId: nnc._id, ticketNumber: t.ticketNumber }, t);
  }

  const tasks = [
    { title: 'Prepare client quotation pack (demo)', assignedTo: amitEmp._id, assignedBy: opsUser._id, dueDate: dayjs().add(2, 'day').toDate(), priority: 'high', status: 'in_progress' },
    { title: 'Update field visit checklist template (demo)', assignedTo: sunilEmp._id, assignedBy: opsUser._id, dueDate: dayjs().add(5, 'day').toDate(), priority: 'medium', status: 'todo' },
    { title: 'Compile June joiners document file (demo)', assignedTo: hrEmp._id, assignedBy: publisherId, dueDate: dayjs().subtract(1, 'day').toDate(), priority: 'medium', status: 'completed', completedAt: dayjs().subtract(1, 'day').toDate() },
  ];
  for (const t of tasks) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Task, { companyId: nnc._id, title: t.title }, { ...t, description: t.title });
  }

  const assets = [
    {
      code: 'NNC-AST-001', name: 'HP ProBook 445 (Demo)', category: 'laptop', serialNumber: 'HP445-NNC-001',
      purchaseDate: dayjs().subtract(8, 'month').toDate(), value: 62000, condition: 'good',
      status: 'assigned', assignedTo: amitEmp._id,
      assignmentHistory: [{ employeeId: amitEmp._id, assignedBy: publisherId, assignedAt: dayjs().subtract(7, 'month').toDate(), note: 'Issued for design work (demo)' }],
    },
    { code: 'NNC-AST-002', name: 'Redmi Note 13 (Demo)', category: 'mobile', serialNumber: 'RMN13-NNC-002', purchaseDate: dayjs().subtract(4, 'month').toDate(), value: 16000, condition: 'good', status: 'available' },
    { code: 'NNC-AST-003', name: 'TVS Jupiter (Demo)', category: 'vehicle', serialNumber: 'KA01-NNC-0003', purchaseDate: dayjs().subtract(1, 'year').toDate(), value: 78000, condition: 'good', status: 'available' },
  ];
  for (const a of assets) {
    // eslint-disable-next-line no-await-in-loop
    await upsertByName(Asset, { companyId: nnc._id, code: a.code }, a);
  }

  const hol1 = upcoming('08-15');
  const hol2 = upcoming('10-02');
  await upsertByName(Holiday, { companyId: nnc._id, name: 'Independence Day', date: hol1.format('YYYY-MM-DD') }, { year: hol1.year(), type: 'public' });
  await upsertByName(Holiday, { companyId: nnc._id, name: 'Gandhi Jayanti', date: hol2.format('YYYY-MM-DD') }, { year: hol2.year(), type: 'public' });
  console.log('  ✔ 2 announcements, 2 tickets, 3 tasks, 3 assets (1 assigned), 2 upcoming holidays');

  // --------------------------------------------------------------------------
  // 10. Final counts (idempotency check — identical across repeat runs)
  // --------------------------------------------------------------------------
  const c = nnc._id;
  const counts = {
    employees: await Employee.countDocuments({ companyId: c }),
    users: await User.countDocuments({ companyId: c }),
    leaveBalances: await LeaveBalance.countDocuments({ companyId: c }),
    branches: await Branch.countDocuments({ companyId: c }),
    departments: await Department.countDocuments({ companyId: c }),
    designations: await Designation.countDocuments({ companyId: c }),
    shifts: await Shift.countDocuments({ companyId: c }),
    attendance: await Attendance.countDocuments({ companyId: c }),
    clients: await Client.countDocuments({ companyId: c }),
    workAssignments: await FieldWorkAssignment.countDocuments({ companyId: c }),
    fieldVisits: await FieldVisit.countDocuments({ companyId: c }),
    gpsLogs: await FieldLocationLog.countDocuments({ companyId: c }),
    loans: await Loan.countDocuments({ companyId: c }),
    leaves: await Leave.countDocuments({ companyId: c }),
    announcements: await Announcement.countDocuments({ companyId: c }),
    tickets: await Ticket.countDocuments({ companyId: c }),
    tasks: await Task.countDocuments({ companyId: c }),
    assets: await Asset.countDocuments({ companyId: c }),
    holidays: await Holiday.countDocuments({ companyId: c }),
  };
  console.log('\nNNC seed complete. Company-scoped document counts:');
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log('\nDemo logins (password Temp@1234):');
  console.log('  manager        rajesh.demo@nnc.example');
  console.log('  hr_admin       priya.demo@nnc.example');
  console.log('  employee       amit.demo@nnc.example');
  console.log('  field_employee sunil.demo@nnc.example');
  console.log('  field_employee kavita.demo@nnc.example');
  process.exit(0);
};

run().catch((err) => {
  console.error('NNC demo seed failed:', err);
  process.exit(1);
});
