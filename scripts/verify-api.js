/* eslint-disable no-console */
// Boots the app on a test port and exercises key endpoints end-to-end.
require('dotenv').config();
const connectDB = require('../src/config/db');
const app = require('../src/app');

const PORT = 5050;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const results = [];
const record = (name, okFlag, info = '') => {
  results.push({ name, ok: okFlag, info });
  console.log(`${okFlag ? 'PASS' : 'FAIL'}  ${name}${info ? ` — ${info}` : ''}`);
};

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* html responses */ }
  return { status: res.status, json };
};

(async () => {
  await connectDB();
  const server = app.listen(PORT);
  try {
    // --- auth ---
    const login = await api('POST', '/auth/login', { body: { email: 'admin@acme.com', password: 'Admin@123' } });
    record('login company_admin', login.status === 200 && login.json.success && login.json.data.tokens.accessToken,
      `features=${(login.json.data && login.json.data.features || []).length}`);
    const adminToken = login.json.data.tokens.accessToken;

    const ownerLogin = await api('POST', '/auth/login', { body: { email: 'owner@hrms.com', password: 'Owner@123' } });
    record('login super_admin', ownerLogin.status === 200);
    const ownerToken = ownerLogin.json.data.tokens.accessToken;

    const fieldLogin = await api('POST', '/auth/login', { body: { email: 'field@acme.com', password: 'Field@123' } });
    record('login field_employee', fieldLogin.status === 200);
    const fieldToken = fieldLogin.json.data.tokens.accessToken;

    const badLogin = await api('POST', '/auth/login', { body: { email: 'admin@acme.com', password: 'wrong' } });
    record('login wrong password → 401', badLogin.status === 401);

    const me = await api('GET', '/auth/me', { token: adminToken });
    record('GET /auth/me', me.status === 200 && me.json.data.company.name === 'Acme Corp');

    // --- platform ---
    const dash = await api('GET', '/platform/dashboard', { token: ownerToken });
    record('GET /platform/dashboard', dash.status === 200 && dash.json.data.companies.total >= 1,
      `companies=${dash.json.data.companies.total} revenue.yearly=${dash.json.data.revenue.yearly}`);
    const forbidden = await api('GET', '/platform/dashboard', { token: adminToken });
    record('platform blocked for company_admin → 403', forbidden.status === 403);

    // --- company dashboard / employees ---
    const cdash = await api('GET', '/dashboard', { token: adminToken });
    record('GET /dashboard (company admin)', cdash.status === 200 && cdash.json.data.employees.total >= 5);
    record('dashboard celebrations (7-day window)', cdash.json.data.celebrations
      && Array.isArray(cdash.json.data.celebrations.birthdays)
      && cdash.json.data.celebrations.anniversaries.length >= 1,
      `anniversaries=${cdash.json.data.celebrations && cdash.json.data.celebrations.anniversaries.length}`);

    const employees = await api('GET', '/employees?page=1&limit=10', { token: adminToken });
    record('GET /employees with pagination', employees.status === 200 && Array.isArray(employees.json.data) && employees.json.pagination.total >= 5,
      `total=${employees.json.pagination && employees.json.pagination.total}`);
    const fieldEmpRow = employees.json.data.find((e) => e.employeeCode === 'EMP0004');

    // --- org chart & bulk import template ---
    const chart = await api('GET', '/employees/org-chart', { token: adminToken });
    record('GET /employees/org-chart', chart.status === 200 && Array.isArray(chart.json.data) && chart.json.data.length >= 1
      && chart.json.data.some((n) => n.children && n.children.length >= 1), `roots=${chart.json.data && chart.json.data.length}`);

    const tmplRes = await fetch(`${BASE}/employees/import-template`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const tmplText = await tmplRes.text();
    record('GET /employees/import-template (csv)', tmplRes.status === 200 && tmplText.startsWith('firstName,lastName,email'));

    // --- attendance ---
    const checkin = await api('POST', '/attendance/check-in', { token: fieldToken, body: { source: 'employee_app', latitude: 19.07, longitude: 72.87 } });
    record('POST /attendance/check-in', [200, 201, 409].includes(checkin.status), checkin.json && checkin.json.message);
    const todayAtt = await api('GET', '/attendance/today', { token: fieldToken });
    record('GET /attendance/today', todayAtt.status === 200);

    // --- work assignments / field visit geo-fencing ---
    const myAssignments = await api('GET', '/work-assignments/my', { token: fieldToken });
    const todayList = myAssignments.json.data.today || [];
    record('GET /work-assignments/my', myAssignments.status === 200 && todayList.length >= 2, `today=${todayList.length}`);
    const assignment = todayList.find((a) => a.status === 'assigned') || todayList[0];

    if (assignment) {
      // far away, no reason → must be 403 with exact message
      const farCheckIn = await api('POST', '/field/visits/check-in', {
        token: fieldToken,
        body: { workAssignmentId: assignment._id, latitude: 18.5, longitude: 73.8 },
      });
      record('field check-in outside fence (no reason) → 403', farCheckIn.status === 403
        && /outside the assigned client location/i.test(farCheckIn.json.message));

      // at client location → checked_in
      const loc = assignment.clientId.location;
      const nearCheckIn = await api('POST', '/field/visits/check-in', {
        token: fieldToken,
        body: { workAssignmentId: assignment._id, latitude: loc.latitude, longitude: loc.longitude },
      });
      record('field check-in inside fence', nearCheckIn.status === 201 && nearCheckIn.json.data.visit.status === 'checked_in',
        `distance=${nearCheckIn.json.data && nearCheckIn.json.data.distanceMeters}m`);
      const visitId = nearCheckIn.json.data.visit._id;

      // location bulk ingest during active visit
      const bulk = await api('POST', '/field/locations/bulk', {
        token: fieldToken,
        body: { points: [{ latitude: loc.latitude + 0.001, longitude: loc.longitude, capturedAt: new Date().toISOString(), batteryLevel: 88 }] },
      });
      record('POST /field/locations/bulk', bulk.status === 201 && bulk.json.data.inserted === 1);

      // live view as admin
      const live = await api('GET', '/field/locations/live', { token: adminToken });
      record('GET /field/locations/live', live.status === 200 && live.json.data.length >= 1, `live=${live.json.data.length}`);

      // checkout
      const checkout = await api('POST', `/field/visits/${visitId}/checkout`, {
        token: fieldToken,
        body: { latitude: loc.latitude, longitude: loc.longitude, remarks: 'done' },
      });
      record('POST /field/visits/:id/checkout', checkout.status === 200 && checkout.json.data.attendance, 'attendance derived');
    }

    // --- leaves ---
    const balance = await api('GET', '/leaves/balance', { token: fieldToken });
    record('GET /leaves/balance', balance.status === 200 && balance.json.data.balances.sick.used >= 1);

    // --- loans ---
    // close disbursed loans left for the field employee by earlier runs (keeps EMI math deterministic)
    const oldLoans = await api('GET', `/loans?employeeId=${fieldEmpRow._id}&status=disbursed&limit=100`, { token: adminToken });
    for (const l of oldLoans.json.data || []) {
      await api('PATCH', `/loans/${l._id}/close`, { token: adminToken });
    }

    const loanReq = await api('POST', '/loans', { token: fieldToken, body: { type: 'advance', amount: 6000, reason: 'Fuel advance' } });
    record('POST /loans (employee request)', loanReq.status === 201 && loanReq.json.data.status === 'requested');
    const loanId = loanReq.json.data._id;

    const loanApprove = await api('PATCH', `/loans/${loanId}/approve`, { token: adminToken, body: { emiAmount: 2000, totalEmis: 3 } });
    record('PATCH /loans/:id/approve', loanApprove.status === 200 && loanApprove.json.data.status === 'approved' && loanApprove.json.data.emiAmount === 2000);

    const loanDisburse = await api('PATCH', `/loans/${loanId}/disburse`, { token: adminToken });
    record('PATCH /loans/:id/disburse (balance = amount)', loanDisburse.status === 200
      && loanDisburse.json.data.status === 'disbursed' && loanDisburse.json.data.balance === 6000);

    const outstanding = await api('GET', '/loans/outstanding', { token: adminToken });
    record('GET /loans/outstanding', outstanding.status === 200 && outstanding.json.data.items.length >= 2 && outstanding.json.data.totals.balance >= 36000,
      `employees=${outstanding.json.data && outstanding.json.data.items.length} balance=${outstanding.json.data && outstanding.json.data.totals.balance}`);

    // --- payroll ---
    const now = new Date();
    const gen = await api('POST', '/payroll/generate', { token: adminToken, body: { month: now.getMonth() + 1, year: now.getFullYear() } });
    record('POST /payroll/generate', gen.status === 201 && gen.json.data.generated >= 5, `generated=${gen.json.data && gen.json.data.generated}`);

    const plist = await api('GET', `/payroll?month=${now.getMonth() + 1}&year=${now.getFullYear()}`, { token: adminToken });
    record('GET /payroll list', plist.status === 200 && plist.json.data.items.length >= 5);

    const fieldPayroll = (plist.json.data.items || []).find((p) => p.employeeId && p.employeeId.employeeCode === 'EMP0004');
    const johnPayroll = (plist.json.data.items || []).find((p) => p.employeeId && p.employeeId.employeeCode === 'EMP0003');
    record('payroll includes loanEmi deduction', Boolean(fieldPayroll) && fieldPayroll.deductions.loanEmi === 2000
      && Boolean(johnPayroll) && johnPayroll.deductions.loanEmi === 5000,
      `field=${fieldPayroll && fieldPayroll.deductions.loanEmi} john=${johnPayroll && johnPayroll.deductions.loanEmi}`);

    // --- loan EMI ledger (v1.6) ---
    // seeded Meera Manager loan: ₹60,000, EMI 10,000 × 6, 2/6 paid (legacy — no ledger entries)
    const disbursedLoans = await api('GET', '/loans?status=disbursed&limit=100', { token: adminToken });
    const meeraLoan = (disbursedLoans.json.data || []).find((l) => l.amount === 60000 && l.totalEmis === 6);
    const meeraDetail = await api('GET', `/loans/${meeraLoan && meeraLoan._id}`, { token: adminToken });
    const dLoan = (meeraDetail.json && meeraDetail.json.data && meeraDetail.json.data.loan) || {};
    const sched = dLoan.schedule || [];
    record('GET /loans/:id derived schedule (6 rows, first 2 legacy-paid)', Boolean(meeraLoan)
      && meeraDetail.status === 200 && Array.isArray(dLoan.payments) && sched.length === 6
      && sched[0].status === 'paid' && sched[1].status === 'paid'
      && sched[0].method === 'payroll' && sched[0].paidAt == null
      && sched.slice(2).every((r) => r.status === 'pending')
      && sched.every((r, i) => r.seq === i + 1 && r.amount === 10000 && /^[A-Z][a-z]{2} \d{4}$/.test(r.dueLabel)),
      `rows=${sched.length} due1=${sched[0] && sched[0].dueLabel}`);

    const cashPay = await api('POST', `/loans/${meeraLoan && meeraLoan._id}/payments`, {
      token: adminToken, body: { method: 'cash', note: 'Verify cash EMI' },
    });
    const cashLoan = (cashPay.json && cashPay.json.data && cashPay.json.data.loan) || {};
    record('POST /loans/:id/payments (cash) → paidEmis 3, balance 30000', cashPay.status === 201
      && cashLoan.paidEmis === 3 && cashLoan.balance === 30000 && cashLoan.status === 'disbursed'
      && (cashLoan.payments || []).some((p) => p.method === 'cash' && p.seq === 3 && p.amount === 10000)
      && cashLoan.schedule[2].status === 'paid' && cashLoan.schedule[2].method === 'cash'
      && Boolean(cashLoan.schedule[2].paidAt),
      `paidEmis=${cashLoan.paidEmis} balance=${cashLoan.balance}`);

    const overPay = await api('POST', `/loans/${meeraLoan && meeraLoan._id}/payments`, {
      token: adminToken, body: { method: 'upi', amount: 999999 },
    });
    const zeroPay = await api('POST', `/loans/${meeraLoan && meeraLoan._id}/payments`, {
      token: adminToken, body: { method: 'upi', amount: 0 },
    });
    record('payment amount > balance or <= 0 → 400', overPay.status === 400 && zeroPay.status === 400);

    const reqLoans = await api('GET', '/loans?status=requested&limit=100', { token: adminToken });
    const requestedLoan = (reqLoans.json.data || [])[0];
    const reqPay = await api('POST', `/loans/${requestedLoan && requestedLoan._id}/payments`, {
      token: adminToken, body: { method: 'cash' },
    });
    record('payment on non-disbursed loan → 400', Boolean(requestedLoan) && reqPay.status === 400);

    // pay the fresh field advance (6000, EMI 2000 × 3) down to zero → auto-close, then reject
    let payOff = null;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      payOff = await api('POST', `/loans/${loanId}/payments`, { token: adminToken, body: { method: 'bank_transfer' } });
    }
    const closedLoan = (payOff.json && payOff.json.data && payOff.json.data.loan) || {};
    record('payments default to EMI amount + auto-close at zero balance', payOff.status === 201
      && closedLoan.status === 'closed' && closedLoan.balance === 0 && closedLoan.paidEmis === 3
      && Boolean(closedLoan.closedAt)
      && (closedLoan.payments || []).length === 3 && closedLoan.payments.every((p) => p.amount === 2000)
      && (closedLoan.schedule || []).every((r) => r.status === 'paid'));

    const afterClose = await api('POST', `/loans/${loanId}/payments`, { token: adminToken, body: { method: 'cash' } });
    record('payment on closed loan → 400', afterClose.status === 400);

    const loanList = await api('GET', '/loans?limit=10', { token: adminToken });
    record('GET /loans list rows unchanged (array, no derived schedule)', loanList.status === 200
      && Array.isArray(loanList.json.data) && loanList.json.data.length >= 1
      && loanList.json.data.every((l) => l.schedule === undefined));

    // --- reports ---
    const report = await api('GET', '/reports/employees', { token: adminToken });
    record('GET /reports/employees', report.status === 200 && report.json.data.rows.length >= 5);
    const csvRes = await fetch(`${BASE}/reports/attendance?format=csv`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const csvText = await csvRes.text();
    record('GET /reports/attendance?format=csv', csvRes.status === 200 && csvText.startsWith('date,'));

    // --- notifications ---
    const notifs = await api('GET', '/notifications', { token: fieldToken });
    record('GET /notifications', notifs.status === 200);

    // --- notifications: admin compose & send ---
    const unreadBefore = notifs.json.data.unreadCount;
    const sendTitle = `Verify notify ${Date.now()}`;
    const sendOne = await api('POST', '/notifications/send', {
      token: adminToken,
      body: { employeeIds: [fieldEmpRow._id], title: sendTitle, message: 'Direct message from verify suite', type: 'announcement' },
    });
    record('POST /notifications/send (single employee)', sendOne.status === 200
      && sendOne.json.data.sent === 1 && sendOne.json.data.targeted === 1
      && sendOne.json.data.skippedNoAccount === 0);

    const afterSend = await api('GET', '/notifications?limit=50', { token: fieldToken });
    record('sent notification lands in employee list + unread bump', afterSend.status === 200
      && afterSend.json.data.items.some((n) => n.title === sendTitle && n.type === 'announcement')
      && afterSend.json.data.unreadCount > unreadBefore,
      `unread ${unreadBefore} → ${afterSend.json.data && afterSend.json.data.unreadCount}`);

    const sendAll = await api('POST', '/notifications/send', {
      token: adminToken,
      body: { all: true, title: `Verify broadcast ${Date.now()}`, message: 'Broadcast from verify suite' },
    });
    record('POST /notifications/send all:true (company-wide)', sendAll.status === 200
      && sendAll.json.data.sent >= 10
      && typeof sendAll.json.data.skippedNoAccount === 'number'
      && sendAll.json.data.targeted >= sendAll.json.data.sent,
      `sent=${sendAll.json.data && sendAll.json.data.sent} targeted=${sendAll.json.data && sendAll.json.data.targeted}`);

    const sendForbidden = await api('POST', '/notifications/send', {
      token: fieldToken, body: { all: true, title: 'Blocked', message: 'Should be forbidden' },
    });
    record('POST /notifications/send blocked for field_employee → 403', sendForbidden.status === 403);

    const sendNoTitle = await api('POST', '/notifications/send', {
      token: adminToken, body: { all: true, message: 'missing title' },
    });
    record('POST /notifications/send missing title → 400', sendNoTitle.status === 400);

    // --- feature gating: toggle off a feature and confirm 403 ---
    const companyId = login.json.data.user.companyId;
    const toggleOff = await api('PUT', `/platform/companies/${companyId}/features`, {
      token: ownerToken, body: { featureKey: 'tasks', enabled: false },
    });
    const tasksBlocked = await api('GET', '/tasks', { token: adminToken });
    const toggleOn = await api('PUT', `/platform/companies/${companyId}/features`, {
      token: ownerToken, body: { featureKey: 'tasks', enabled: true },
    });
    record('feature toggle off → 403 on /tasks', toggleOff.status === 200 && tasksBlocked.status === 403 && toggleOn.status === 200);

    // ===================== HR Extensions v1.2 =====================
    const johnLogin = await api('POST', '/auth/login', { body: { email: 'john@acme.com', password: 'John@123' } });
    const johnToken = johnLogin.json.data.tokens.accessToken;
    const managerLogin = await api('POST', '/auth/login', { body: { email: 'manager@acme.com', password: 'Manager@123' } });
    const managerToken = managerLogin.json.data.tokens.accessToken;

    // --- projects & timesheets ---
    const projCreate = await api('POST', '/projects', {
      token: adminToken,
      body: { name: `Verify Project ${Date.now()}`, code: 'VRF', description: 'verify suite project', members: [fieldEmpRow._id] },
    });
    record('POST /projects (create)', projCreate.status === 201 && projCreate.json.data.status === 'active');
    const projectId = projCreate.json.data._id;

    const tsDate = new Date().toISOString().slice(0, 10);
    const tsSubmit = await api('POST', '/projects/timesheets', {
      token: fieldToken,
      body: { projectId, date: tsDate, hours: 6, note: 'verify entry', billable: true },
    });
    record('POST /projects/timesheets (submit)', tsSubmit.status === 201 && tsSubmit.json.data.status === 'submitted');

    const tsApprove = await api('PATCH', `/projects/timesheets/${tsSubmit.json.data._id}/approve`, { token: managerToken });
    record('PATCH /projects/timesheets/:id/approve', tsApprove.status === 200 && tsApprove.json.data.status === 'approved'
      && Boolean(tsApprove.json.data.actionAt));

    const tsSummary = await api('GET', `/projects/timesheets/summary?projectId=${projectId}`, { token: adminToken });
    const tsFieldRow = ((tsSummary.json.data && tsSummary.json.data.perEmployee) || [])
      .find((r) => String(r.employeeId) === String(fieldEmpRow._id)) || {};
    record('GET /projects/timesheets/summary (perEmployee)', tsSummary.status === 200
      && tsFieldRow.totalHours === 6 && tsFieldRow.billableHours === 6, `hours=${tsFieldRow.totalHours}`);

    const projDetail = await api('GET', `/projects/${projectId}`, { token: fieldToken });
    record('GET /projects/:id (taskCount + memberCount)', projDetail.status === 200
      && projDetail.json.data.taskCount === 0 && projDetail.json.data.memberCount === 1);

    const seededProj = await api('GET', `/projects?search=${encodeURIComponent('Prestige Villa')}`, { token: adminToken });
    const villa = (seededProj.json.data || []).find((p) => p.name === 'Prestige Villa Interiors');
    const villaSummary = villa
      ? await api('GET', `/projects/timesheets/summary?projectId=${villa._id}`, { token: adminToken })
      : { json: {} };
    record('seeded project has 4+ timesheets in summary', Boolean(villa)
      && villaSummary.json.data && villaSummary.json.data.totals.entries >= 4,
      `entries=${villaSummary.json.data && villaSummary.json.data.totals.entries}`);

    // --- HR policies ---
    const polCreate = await api('POST', '/policies', {
      token: adminToken,
      body: { title: `Verify Policy ${Date.now()}`, description: 'verify policy', url: '/uploads/placeholder.pdf' },
    });
    record('POST /policies (create)', polCreate.status === 201 && polCreate.json.data.version === 1);
    const policyId = polCreate.json.data._id;

    const polAck = await api('POST', `/policies/${policyId}/acknowledge`, { token: fieldToken });
    record('POST /policies/:id/acknowledge', polAck.status === 201 && Boolean(polAck.json.data.acknowledgedAt));

    const polList = await api('GET', '/policies?limit=100', { token: fieldToken });
    const polRow = (polList.json.data || []).find((p) => String(p._id) === String(policyId));
    record('GET /policies (employee: active-only + acknowledged flag)', polList.status === 200
      && Boolean(polRow) && polRow.acknowledged === true
      && (polList.json.data || []).every((p) => p.active === true));

    const polAcks = await api('GET', `/policies/${policyId}/acks`, { token: adminToken });
    const polAckRow = (polAcks.json.data || []).find((r) => r.employee && r.employee.employeeCode === 'EMP0004');
    record('GET /policies/:id/acks (all active employees)', polAcks.status === 200
      && polAcks.json.data.length >= 5 && Boolean(polAckRow && polAckRow.acknowledgedAt),
      `rows=${polAcks.json.data && polAcks.json.data.length}`);

    // --- training ---
    const courseCreate = await api('POST', '/training/courses', {
      token: adminToken,
      body: { title: `Verify Course ${Date.now()}`, type: 'link', url: 'https://example.com/course', durationMinutes: 20 },
    });
    record('POST /training/courses (create)', courseCreate.status === 201 && courseCreate.json.data.active === true);
    const courseId = courseCreate.json.data._id;

    const courseAssign = await api('POST', '/training/assign', { token: adminToken, body: { courseId, employeeIds: [fieldEmpRow._id] } });
    record('POST /training/assign', courseAssign.status === 201 && courseAssign.json.data.assigned === 1);

    const myTraining = await api('GET', '/training/my?limit=100', { token: fieldToken });
    const myAssignmentRow = (myTraining.json.data || []).find((a) => a.courseId && String(a.courseId._id) === String(courseId));
    record('GET /training/my (course populated)', myTraining.status === 200 && Boolean(myAssignmentRow)
      && myAssignmentRow.status === 'assigned' && Boolean(myAssignmentRow.courseId.title));

    const courseComplete = await api('PATCH', `/training/assignments/${myAssignmentRow && myAssignmentRow._id}/complete`, { token: fieldToken });
    record('PATCH /training/assignments/:id/complete', courseComplete.status === 200
      && courseComplete.json.data.status === 'completed' && Boolean(courseComplete.json.data.completedAt));

    const courseProgress = await api('GET', `/training/courses/${courseId}/progress`, { token: adminToken });
    record('GET /training/courses/:id/progress', courseProgress.status === 200
      && courseProgress.json.data.totals.assigned >= 1 && courseProgress.json.data.totals.completed >= 1);

    // --- leave approval chain (Acme seeds approvalLevels: 2) ---
    const chainFrom = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const chainTo = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
    // cancel overlapping rows left behind by earlier runs (keeps the apply repeatable)
    const johnLeaves = await api('GET', '/leaves?limit=100', { token: johnToken });
    for (const l of johnLeaves.json.data || []) {
      if (['pending', 'approved'].includes(l.status) && l.fromDate <= chainTo && l.toDate >= chainFrom) {
        await api('PATCH', `/leaves/${l._id}/cancel`, { token: johnToken });
      }
    }

    const leaveApply = await api('POST', '/leaves', {
      token: johnToken,
      body: { leaveType: 'casual', fromDate: chainFrom, toDate: chainTo, reason: 'Verify chain leave' },
    });
    const chain = (leaveApply.json.data && leaveApply.json.data.approvalChain) || [];
    record('POST /leaves builds 2-level chain', leaveApply.status === 201 && chain.length === 2
      && chain[0].role === 'manager' && chain[1].role === 'hr_admin' && leaveApply.json.data.currentLevel === 1,
      `levels=${chain.length}`);
    const chainLeaveId = leaveApply.json.data._id;

    const l1Approve = await api('PATCH', `/leaves/${chainLeaveId}/approve`, { token: managerToken });
    record('L1 approve → still pending at level 2', l1Approve.status === 200 && l1Approve.json.data.status === 'pending'
      && l1Approve.json.data.currentLevel === 2 && l1Approve.json.data.approvalChain[0].status === 'approved');

    const l2AsManager = await api('PATCH', `/leaves/${chainLeaveId}/approve`, { token: managerToken });
    record('L2 approve blocked for manager → 403', l2AsManager.status === 403);

    const l2Approve = await api('PATCH', `/leaves/${chainLeaveId}/approve`, { token: adminToken });
    record('L2 approve → approved (chain length 2)', l2Approve.status === 200 && l2Approve.json.data.status === 'approved'
      && l2Approve.json.data.approvalChain.length === 2
      && l2Approve.json.data.approvalChain.every((s) => s.status === 'approved'));
    // restore john's balance so repeated runs never exhaust it
    await api('PATCH', `/leaves/${chainLeaveId}/cancel`, { token: johnToken });

    // --- form 16 & payslip emailing ---
    const payRef = new Date(now.getFullYear(), now.getMonth() - 1, 1); // seeded payroll month
    const payMonth = payRef.getMonth() + 1;
    const payYear = payRef.getFullYear();
    const fyStart = payMonth >= 4 ? payYear : payYear - 1;
    const johnEmployeeId = johnLogin.json.data.user.employeeId;

    const form16 = await api('GET', `/payroll/form16?employeeId=${johnEmployeeId}&fy=${fyStart}`, { token: adminToken });
    record('GET /payroll/form16 (FY aggregates)', form16.status === 200 && form16.json.data.fy === fyStart
      && form16.json.data.months >= 1 && form16.json.data.gross > 0
      && form16.json.data.deductions && typeof form16.json.data.deductions.pf === 'number'
      && form16.json.data.netTotal > 0,
      `months=${form16.json.data && form16.json.data.months} gross=${form16.json.data && form16.json.data.gross}`);

    const emailRun = await api('POST', '/payroll/email-payslips', { token: adminToken, body: { month: payMonth, year: payYear } });
    record('POST /payroll/email-payslips (counts)', emailRun.status === 200
      && emailRun.json.data.sent >= 1 && typeof emailRun.json.data.skipped === 'number',
      `sent=${emailRun.json.data && emailRun.json.data.sent} skipped=${emailRun.json.data && emailRun.json.data.skipped}`);

    // ===================== v1.3 — Increment Requests =====================
    const hrLogin = await api('POST', '/auth/login', { body: { email: 'hr@acme.com', password: 'Hr@12345' } });
    const hrToken = hrLogin.json.data.tokens.accessToken;

    // resolve john's open requests left by seed/earlier runs (keeps the submit repeatable)
    const oldInc = await api('GET', '/increments?limit=100', { token: adminToken });
    for (const r of oldInc.json.data || []) {
      if (['requested', 'under_review'].includes(r.status) && r.employeeId && String(r.employeeId._id) === String(johnEmployeeId)) {
        await api('PATCH', `/increments/${r._id}/reject`, { token: hrToken, body: { note: 'Superseded by verify run' } });
      }
    }

    const incSubmit = await api('POST', '/increments', {
      token: johnToken,
      body: { requestedCtc: 660000, reason: 'Verify increment request' },
    });
    record('POST /increments (employee submit, ctc snapshot)', incSubmit.status === 201
      && incSubmit.json.data.status === 'requested' && incSubmit.json.data.currentCtc === 600000,
      `currentCtc=${incSubmit.json.data && incSubmit.json.data.currentCtc}`);
    const incId = incSubmit.json.data._id;

    const incDup = await api('POST', '/increments', { token: johnToken, body: { requestedCtc: 700000, reason: 'duplicate' } });
    record('POST /increments duplicate while open → 409', incDup.status === 409);

    const incApprove = await api('PATCH', `/increments/${incId}/approve`, {
      token: hrToken,
      body: { note: 'Approved in verify run', generateLetter: false },
    });
    record('PATCH /increments/:id/approve (HR)', incApprove.status === 200
      && incApprove.json.data.request.status === 'approved' && Boolean(incApprove.json.data.request.actionAt));

    const incMine = await api('GET', '/increments', { token: johnToken });
    const incMineRow = (incMine.json.data || []).find((r) => String(r._id) === String(incId));
    record('GET /increments (employee own history shows approved)', incMine.status === 200
      && Boolean(incMineRow) && incMineRow.status === 'approved'
      && (incMine.json.data || []).every((r) => r.employeeId && String(r.employeeId._id) === String(johnEmployeeId)),
      `rows=${(incMine.json.data || []).length}`);

    // ===================== v1.4 — audit gap fixes =====================

    // --- leaves/balances (company-wide, lazily complete) ---
    const balances = await api('GET', '/leaves/balances', { token: adminToken });
    const balItems = (balances.json.data && balances.json.data.items) || [];
    const balRow = balItems.find((r) => r.employee && r.employee.employeeCode === 'EMP0004');
    record('GET /leaves/balances (shape, every active employee)', balances.status === 200
      && balItems.length >= 5 && Boolean(balRow)
      && Boolean(balRow.employee.personal && balRow.employee.personal.firstName)
      && balRow.casual.available === balRow.casual.total - balRow.casual.used
      && balRow.sick.available === balRow.sick.total - balRow.sick.used
      && typeof balRow.unpaidTaken === 'number' && typeof balRow.totalRemaining === 'number',
      `rows=${balItems.length}`);
    const balancesBlocked = await api('GET', '/leaves/balances', { token: johnToken });
    record('GET /leaves/balances blocked for employee → 403', balancesBlocked.status === 403);

    // --- new report builders ---
    const repFrom = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const repTo = new Date().toISOString().slice(0, 10);
    const expReport = await api('GET', `/reports/expenses?from=${repFrom}&to=${repTo}`, { token: adminToken });
    record('GET /reports/expenses', expReport.status === 200
      && expReport.json.data.columns.includes('employeeName') && expReport.json.data.rows.length >= 1,
      `rows=${expReport.json.data && expReport.json.data.rows.length}`);

    const assetReport = await api('GET', '/reports/assets', { token: adminToken });
    record('GET /reports/assets', assetReport.status === 200
      && assetReport.json.data.columns.includes('assetCode') && assetReport.json.data.rows.length >= 1
      && assetReport.json.data.rows.some((r) => r.assignedTo));

    const compReport = await api('GET', '/reports/companies', { token: ownerToken });
    record('GET /reports/companies (platform)', compReport.status === 200
      && compReport.json.data.rows.some((r) => r.name === 'Acme Corp' && r.employeeCount >= 5 && r.plan === 'Premium'));

    const payReport = await api('GET', '/reports/payments', { token: ownerToken });
    record('GET /reports/payments (platform)', payReport.status === 200
      && payReport.json.data.columns.join(',') === 'companyName,invoiceNumber,amount,status,method,date'
      && payReport.json.data.rows.length >= 1);

    const fuReport = await api('GET', '/reports/feature-usage', { token: ownerToken });
    const fuRow = ((fuReport.json.data && fuReport.json.data.rows) || []).find((r) => r.featureKey === 'attendance');
    record('GET /reports/feature-usage (platform)', fuReport.status === 200
      && Boolean(fuRow) && fuRow.companiesEnabled >= 1, `attendance=${fuRow && fuRow.companiesEnabled}`);

    const platformReportBlocked = await api('GET', '/reports/companies', { token: adminToken });
    record('platform report blocked for company_admin → 403', platformReportBlocked.status === 403);

    // --- field summary: company-wide + month mode ---
    const fsAll = await api('GET', '/field/visits/summary', { token: adminToken });
    record('GET /field/visits/summary (company-wide, no employeeId)', fsAll.status === 200
      && fsAll.json.data.totalVisits >= 1 && typeof fsAll.json.data.daysWorked === 'number'
      && typeof fsAll.json.data.totalWorkMinutes === 'number' && typeof fsAll.json.data.totalDistanceKm === 'number',
      `visits=${fsAll.json.data && fsAll.json.data.totalVisits}`);

    const ym = new Date().toISOString().slice(0, 7);
    const fsMonth = await api('GET', `/field/visits/summary?month=${ym}`, { token: fieldToken });
    record('GET /field/visits/summary?month= (field self)', fsMonth.status === 200
      && fsMonth.json.data.daysWorked >= 1 && typeof fsMonth.json.data.pendingVisits === 'number',
      `daysWorked=${fsMonth.json.data && fsMonth.json.data.daysWorked}`);

    // --- field expenses by workAssignmentId / route by visitId ---
    const expAll = await api('GET', '/field/expenses?limit=100', { token: adminToken });
    const expWithWa = (expAll.json.data || []).find((x) => x.workAssignmentId);
    const waId = expWithWa && (expWithWa.workAssignmentId._id || expWithWa.workAssignmentId);
    const expByWa = await api('GET', `/field/expenses?workAssignmentId=${waId}`, { token: adminToken });
    record('GET /field/expenses?workAssignmentId=', Boolean(waId) && expByWa.status === 200
      && (expByWa.json.data || []).length >= 1
      && expByWa.json.data.every((x) => String(x.workAssignmentId._id || x.workAssignmentId) === String(waId)));

    const anyVisit = await api('GET', '/field/visits?limit=1', { token: adminToken });
    const visitRow = (anyVisit.json.data || [])[0];
    const routeByVisit = await api('GET', `/field/locations/route?visitId=${visitRow && visitRow._id}`, { token: adminToken });
    record('GET /field/locations/route?visitId=', Boolean(visitRow) && routeByVisit.status === 200
      && String(routeByVisit.json.data.employeeId) === String(visitRow.employeeId._id)
      && routeByVisit.json.data.date === visitRow.date,
      `points=${routeByVisit.json.data && routeByVisit.json.data.pointCount}`);

    // --- org lists include employeeCount ---
    const deptList = await api('GET', '/departments', { token: adminToken });
    const branchList = await api('GET', '/branches', { token: adminToken });
    const desigList = await api('GET', '/designations', { token: adminToken });
    record('org lists include employeeCount', deptList.status === 200 && branchList.status === 200 && desigList.status === 200
      && deptList.json.data.every((d) => typeof d.employeeCount === 'number')
      && branchList.json.data.every((b) => typeof b.employeeCount === 'number')
      && desigList.json.data.every((g) => typeof g.employeeCount === 'number')
      && deptList.json.data.some((d) => d.employeeCount >= 1),
      `depts=${deptList.json.data.length}`);

    // --- company settings: leave whitelist ---
    const settingsSave = await api('PUT', '/company/profile', {
      token: adminToken, body: { settings: { leave: { approvalLevels: 2, level3MinDays: 6 } } },
    });
    const settingsBack = await api('PUT', '/company/profile', {
      token: adminToken, body: { settings: { leave: { level3MinDays: 5 } } },
    });
    record('PUT /company/profile persists settings.leave', settingsSave.status === 200
      && settingsSave.json.data.settings.leave.level3MinDays === 6
      && settingsBack.status === 200 && settingsBack.json.data.settings.leave.approvalLevels === 2
      && settingsBack.json.data.settings.leave.level3MinDays === 5);

    // --- notifications: {items, unreadCount} + isRead filter ---
    const notifList = await api('GET', '/notifications?isRead=false', { token: fieldToken });
    record('GET /notifications {items,unreadCount} + isRead filter', notifList.status === 200
      && Array.isArray(notifList.json.data.items) && typeof notifList.json.data.unreadCount === 'number'
      && notifList.json.data.items.every((n) => n.isRead === false),
      `unread=${notifList.json.data && notifList.json.data.unreadCount}`);

    // --- auth preferences roundtrip ---
    const prefSave = await api('PATCH', '/auth/me/preferences', {
      token: adminToken, body: { preferences: { theme: 'dark', density: 'compact' } },
    });
    const meAfterPref = await api('GET', '/auth/me', { token: adminToken });
    record('PATCH /auth/me/preferences roundtrip', prefSave.status === 200
      && prefSave.json.data.user.preferences.theme === 'dark'
      && meAfterPref.status === 200 && meAfterPref.json.data.user.preferences.theme === 'dark'
      && meAfterPref.json.data.user.preferences.density === 'compact');

    // --- super_admin platform tickets (no companyId) ---
    const ownerTickets = await api('GET', '/tickets?limit=100', { token: ownerToken });
    const ownerTicketRows = ownerTickets.json.data || [];
    record('GET /tickets as super_admin (companyId populated)', ownerTickets.status === 200
      && ownerTicketRows.length >= 5
      && ownerTicketRows.every((t) => t.companyId && t.companyId.name),
      `tickets=${ownerTicketRows.length}`);

    const openTicket = ownerTicketRows.find((t) => t.status === 'open');
    const ownerReply = await api('POST', `/tickets/${openTicket && openTicket._id}/replies`, {
      token: ownerToken, body: { message: 'Platform support: looking into this.' },
    });
    record('POST /tickets/:id/replies as super_admin', Boolean(openTicket) && ownerReply.status === 200
      && ownerReply.json.data.comments.some((c) => c.message === 'Platform support: looking into this.'));

    const ownerStatusChange = await api('PATCH', `/tickets/${openTicket && openTicket._id}/status`, {
      token: ownerToken, body: { status: 'in_progress' },
    });
    record('PATCH /tickets/:id/status as super_admin', ownerStatusChange.status === 200
      && ownerStatusChange.json.data.status === 'in_progress');

    // --- attendance month param ---
    const attMonth = await api('GET', `/attendance?month=${ym}&limit=200`, { token: adminToken });
    record('GET /attendance?month=YYYY-MM', attMonth.status === 200
      && (attMonth.json.data || []).length >= 1
      && attMonth.json.data.every((a) => a.date.startsWith(ym)),
      `rows=${(attMonth.json.data || []).length}`);

    // --- platform dashboard pendingPayments (seed a 'created' payment first) ---
    const plansList = await api('GET', '/platform/plans', { token: ownerToken });
    const anyPlan = (plansList.json.data || []).find((p) => p.name === 'Premium') || (plansList.json.data || [])[0];
    const orderRes = await api('POST', '/platform/payments/order', {
      token: ownerToken, body: { companyId, planId: anyPlan._id, billingCycle: 'monthly' },
    });
    const dashAfterOrder = await api('GET', '/platform/dashboard', { token: ownerToken });
    record('platform dashboard pendingPayments {count, amount}', orderRes.status === 201
      && dashAfterOrder.status === 200
      && dashAfterOrder.json.data.pendingPayments.count >= 1
      && dashAfterOrder.json.data.pendingPayments.amount >= anyPlan.monthlyPrice,
      `count=${dashAfterOrder.json.data.pendingPayments && dashAfterOrder.json.data.pendingPayments.count}`);

    // --- company usage: activeAssignments + storageUsed ---
    const usage = await api('GET', `/platform/companies/${companyId}/usage`, { token: ownerToken });
    record('GET /platform/companies/:id/usage (activeAssignments + storageUsed)', usage.status === 200
      && typeof usage.json.data.activeAssignments === 'number' && usage.json.data.activeAssignments >= 1
      && typeof usage.json.data.storageUsed === 'number' && usage.json.data.storageUnit === 'bytes',
      `active=${usage.json.data && usage.json.data.activeAssignments}`);

    // --- companies list: subscription.employeeLimit ---
    const compList = await api('GET', '/platform/companies', { token: ownerToken });
    const acmeRow = (compList.json.data || []).find((c) => c.name === 'Acme Corp');
    record('GET /platform/companies includes subscription.employeeLimit', compList.status === 200
      && Boolean(acmeRow && acmeRow.subscription) && typeof acmeRow.subscription.employeeLimit === 'number',
      `limit=${acmeRow && acmeRow.subscription && acmeRow.subscription.employeeLimit}`);

    // --- renew honors endDate + planId ---
    const acmeSubs = await api('GET', `/platform/subscriptions?companyId=${companyId}&limit=1`, { token: ownerToken });
    const latestSub = (acmeSubs.json.data || [])[0];
    const customEnd = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const renewed = await api('POST', `/platform/subscriptions/${latestSub && latestSub._id}/renew`, {
      token: ownerToken, body: { endDate: customEnd, planId: anyPlan._id },
    });
    record('POST /platform/subscriptions/:id/renew honors endDate + planId', Boolean(latestSub)
      && renewed.status === 201
      && renewed.json.data.endDate.slice(0, 10) === customEnd
      && String(renewed.json.data.planId) === String(anyPlan._id));

    // --- personal dashboard pendingLeaveItems ---
    const plDate = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const pendApply = await api('POST', '/leaves', {
      token: johnToken, body: { leaveType: 'unpaid', fromDate: plDate, toDate: plDate, reason: 'Verify pending item' },
    });
    const johnDash = await api('GET', '/dashboard', { token: johnToken });
    record('personal dashboard pendingLeaveItems (latest 5)', pendApply.status === 201 && johnDash.status === 200
      && Array.isArray(johnDash.json.data.pendingLeaveItems)
      && johnDash.json.data.pendingLeaveItems.some((l) => String(l._id) === String(pendApply.json.data._id))
      && typeof johnDash.json.data.pendingLeaves === 'number',
      `items=${(johnDash.json.data.pendingLeaveItems || []).length}`);
    await api('PATCH', `/leaves/${pendApply.json.data._id}/cancel`, { token: johnToken });

    // --- announcement pinned roundtrip + pinned-first sort ---
    const annCreate = await api('POST', '/announcements', {
      token: adminToken, body: { title: `Pinned verify ${Date.now()}`, message: 'pinned announcement', pinned: true },
    });
    const annManage = await api('GET', '/announcements/manage', { token: adminToken });
    const annReader = await api('GET', '/announcements?limit=5', { token: johnToken });
    record('announcement pinned roundtrip (pinned-first in manage + reader)', annCreate.status === 201
      && annCreate.json.data.pinned === true
      && annManage.status === 200 && annManage.json.data[0] && annManage.json.data[0].pinned === true
      && annReader.status === 200 && annReader.json.data[0]
      && String(annReader.json.data[0]._id) === String(annCreate.json.data._id));
    const annUpdate = await api('PUT', `/announcements/${annCreate.json.data._id}`, {
      token: adminToken, body: { pinned: false },
    });
    record('announcement pinned accepted on update', annUpdate.status === 200 && annUpdate.json.data.pinned === false);
    await api('DELETE', `/announcements/${annCreate.json.data._id}`, { token: adminToken });

    // ===================== v1.5 — server-side list contract =====================
    const ids = (rows) => (rows || []).map((r) => String(r._id));
    const matchesAny = (row, fields, term) => fields.some((f) => {
      const v = f.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
      return v != null && String(v).toLowerCase().includes(term.toLowerCase());
    });

    const listContract = async (name, path, { token, searchTerm, searchFields }) => {
      const sep = path.includes('?') ? '&' : '?';
      const all = await api('GET', `${path}${sep}limit=500&sort=-createdAt`, { token });
      const allIds = ids(all.json.data);
      const total = all.json.pagination.total;

      // page=2&limit=2 → the exact slice [2,4) of the identically-sorted full list
      const p2 = await api('GET', `${path}${sep}page=2&limit=2&sort=-createdAt`, { token });
      record(`v1.5 ${name}: page=2&limit=2 slice + total/totalPages`, p2.status === 200
        && p2.json.pagination.page === 2 && p2.json.pagination.limit === 2
        && p2.json.pagination.total === total
        && p2.json.pagination.totalPages === Math.ceil(total / 2)
        && JSON.stringify(ids(p2.json.data)) === JSON.stringify(allIds.slice(2, 4)),
        `total=${total} totalPages=${p2.json.pagination && p2.json.pagination.totalPages}`);

      // search narrows the result set and every row matches a searchable field
      const found = await api('GET', `${path}${sep}limit=500&search=${encodeURIComponent(searchTerm)}`, { token });
      record(`v1.5 ${name}: search "${searchTerm}" narrows`, found.status === 200
        && found.json.pagination.total >= 1 && found.json.pagination.total < total
        && (found.json.data || []).every((r) => matchesAny(r, searchFields, searchTerm)),
        `matches=${found.json.pagination && found.json.pagination.total}/${total}`);

      // sort=createdAt is the exact reverse of sort=-createdAt (stable via _id tiebreak)
      const asc = await api('GET', `${path}${sep}limit=500&sort=createdAt`, { token });
      record(`v1.5 ${name}: sort=createdAt flips sort=-createdAt`, asc.status === 200
        && allIds.length === total
        && JSON.stringify(ids(asc.json.data)) === JSON.stringify(allIds.slice().reverse()));

      // un-whitelisted sort field silently falls back to the default order (no 500)
      const bogus = await api('GET', `${path}${sep}limit=5&sort=__not_a_field__`, { token });
      record(`v1.5 ${name}: un-whitelisted sort falls back (no 500)`, bogus.status === 200
        && Array.isArray(bogus.json.data) && Boolean(bogus.json.pagination));
    };

    await listContract('/employees', '/employees', {
      token: adminToken, searchTerm: 'Kavya',
      searchFields: ['personal.firstName', 'personal.lastName', 'personal.email', 'employeeCode', 'personal.phone'],
    });
    await listContract('/clients', '/clients', {
      token: adminToken, searchTerm: 'Globex',
      searchFields: ['name', 'code', 'contactPerson', 'phone', 'address'],
    });
    await listContract('/tickets', '/tickets', {
      token: adminToken, searchTerm: 'Laptop',
      searchFields: ['subject', 'ticketNumber'],
    });
    await listContract('/work-assignments', '/work-assignments', {
      token: adminToken, searchTerm: 'installation',
      searchFields: ['title', 'description', 'status'],
    });

    // composite-shape lists: pagination metadata added alongside, opt-in slicing
    const balAll = await api('GET', '/leaves/balances', { token: adminToken });
    const balPage = await api('GET', '/leaves/balances?page=1&limit=2', { token: adminToken });
    const balSearch = await api('GET', '/leaves/balances?search=Kavya', { token: adminToken });
    record('v1.5 /leaves/balances: pagination alongside {items} + opt-in slice + search', balAll.status === 200
      && Boolean(balAll.json.pagination) && balAll.json.data.items.length === balAll.json.pagination.total
      && balPage.status === 200 && balPage.json.data.items.length === 2
      && balPage.json.pagination.limit === 2
      && balPage.json.pagination.totalPages === Math.ceil(balPage.json.pagination.total / 2)
      && balSearch.status === 200 && balSearch.json.pagination.total >= 1
      && balSearch.json.pagination.total < balAll.json.pagination.total
      && balSearch.json.data.items.every((r) => `${r.employee.personal.firstName} ${r.employee.personal.lastName}`.toLowerCase().includes('kavya')),
      `rows=${balAll.json.pagination && balAll.json.pagination.total}`);

    const outAll = await api('GET', '/loans/outstanding', { token: adminToken });
    const outPage = await api('GET', '/loans/outstanding?page=1&limit=1&sort=-totalBalance', { token: adminToken });
    record('v1.5 /loans/outstanding: pagination alongside {items,totals} + opt-in slice', outAll.status === 200
      && Boolean(outAll.json.pagination) && outAll.json.data.items.length === outAll.json.pagination.total
      && Boolean(outAll.json.data.totals)
      && outPage.status === 200 && outPage.json.data.items.length === 1
      && outPage.json.pagination.total === outAll.json.pagination.total
      && outPage.json.data.totals.balance === outAll.json.data.totals.balance,
      `rows=${outAll.json.pagination && outAll.json.pagination.total}`);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error('VERIFY ERROR:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
})();
