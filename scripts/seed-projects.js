/**
 * Seeds the Projects workspace with demo data: industry templates, projects
 * dated across their phases, tasks, timesheets and module rows.
 *
 * Idempotent. Projects are keyed on (companyId, name), module rows and tasks on
 * (project, title), so re-running tops up what is missing instead of
 * duplicating. Nothing is deleted.
 *
 *   node scripts/seed-projects.js            # every demo company
 *   node scripts/seed-projects.js ACME       # one company, by code
 *
 * The timesheet mismatches it creates are REAL: the script looks up days the
 * employee was actually on leave or absent and logs hours there, so the
 * attendance reconciliation flags them on its own merits.
 */
const path = require('path');
const dayjs = require('dayjs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const Company = require('../src/models/Company');
const Client = require('../src/models/Client');
const Employee = require('../src/models/Employee');
const Attendance = require('../src/models/Attendance');
const Project = require('../src/models/Project');
const ProjectTemplate = require('../src/models/ProjectTemplate');
const ProjectModuleItem = require('../src/models/ProjectModuleItem');
const Task = require('../src/models/Task');
const Timesheet = require('../src/models/Timesheet');
const User = require('../src/models/User');
const { BLUEPRINTS, toTemplate } = require('../src/constants/projectBlueprints');

// Deterministic PRNG so repeated runs produce the same numbers.
const rng = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const today = dayjs().startOf('day');
const iso = (d) => d.format('YYYY-MM-DD');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * The projects each demo company gets. `shape` pins the health outcome so the
 * saved views and signals all have something in them:
 *   onTrack   work keeping pace, budget in line
 *   behind    work well behind the calendar  -> off track
 *   overspend budget far ahead of work       -> off track
 *   waiting   an approval the client has sat on -> at risk
 *   hold / done
 */
const PLAN = {
  ACME: [
    { name: 'Prestige Villa Interiors', tmpl: 'interior', shape: 'onTrack', value: 3400000, days: 140, elapsed: 32 },
    { name: 'Villa interiors, Whitefield', tmpl: 'interior', shape: 'onTrack', value: 2850000, days: 120, elapsed: 46 },
    { name: 'Website Revamp 2026', tmpl: 'web', shape: 'waiting', value: 1450000, days: 150, elapsed: 96 },
    { name: 'Warehouse Automation', tmpl: 'web', shape: 'behind', value: 2200000, days: 180, elapsed: 150 },
    { name: 'Annual dealer meet', tmpl: 'events', shape: 'overspend', value: 1850000, days: 75, elapsed: 52 },
    { name: 'Social media retainer', tmpl: 'marketing', shape: 'onTrack', value: 420000, days: 90, elapsed: 38 },
    { name: 'Water purifier AMC, 40 units', tmpl: 'facility', shape: 'onTrack', value: 360000, days: 365, elapsed: 120 },
    { name: 'ERP Migration Phase 1', tmpl: 'web', shape: 'hold', value: 3100000, days: 210, elapsed: 90 },
    { name: 'Retail Kiosk Pilot', tmpl: 'web', shape: 'done', value: 780000, days: 90, elapsed: 110 },
  ],
  GLOBEX: [
    { name: 'Penthouse, Koramangala', tmpl: 'interior', shape: 'onTrack', value: 4200000, days: 150, elapsed: 60 },
    { name: 'Office floor, Outer Ring Road', tmpl: 'interior', shape: 'waiting', value: 6100000, days: 180, elapsed: 120 },
    { name: 'G+3 residence, Jayanagar', tmpl: 'architecture', shape: 'behind', value: 1850000, days: 200, elapsed: 170 },
    { name: 'Clinic fit-out, HSR Layout', tmpl: 'interior', shape: 'onTrack', value: 1950000, days: 100, elapsed: 30 },
    { name: 'Café interiors, Indiranagar', tmpl: 'interior', shape: 'done', value: 1250000, days: 85, elapsed: 100 },
  ],
};

/** Work-done percentage each shape targets, relative to time elapsed. */
const PACE = { onTrack: 1.0, waiting: 0.95, behind: 0.52, overspend: 0.9, hold: 0.7, done: 1 };
/** Budget consumed relative to work done. */
const BURN = { onTrack: 0.98, waiting: 1.0, behind: 1.05, overspend: 1.45, hold: 1.0, done: 1.02 };

const TASK_TITLES = {
  interior: ['Site measurement verification', 'Modular kitchen shop drawings', 'False ceiling layout', 'Electrical point marking', 'Wardrobe laminate selection', 'Lighting plan revision', 'Carpentry on site', 'Final polish and cleaning'],
  web: ['Discovery workshop notes', 'Wireframes for key screens', 'Design system setup', 'Checkout API integration', 'Role-based access', 'Payment gateway webhooks', 'Load testing', 'Content migration'],
  events: ['Venue walkthrough', 'Stage fabrication sign-off', 'Guest list final count', 'Caterer tasting', 'Sound check', 'Transport roster', 'Emcee script', 'Settlement sheet'],
  marketing: ['Content calendar, month 1', 'Instagram carousel set', 'Search ad copy refresh', 'Landing page A/B test', 'Blog: category guide', 'Monthly report'],
  facility: ['Asset tagging across sites', 'Q1 preventive maintenance', 'Filter replacement, block A', 'Breakdown call log review', 'Spare parts audit', 'Quarterly SLA report'],
  architecture: ['Concept massing options', 'Ground floor plan, R3', 'Elevation options', 'Section through stair core', 'Door and window schedule', 'Plan sanction submission set'],
};

/** Module rows per module type. Dates and amounts are filled in per project. */
const MODULE_ROWS = {
  approvals: [
    { title: 'Living room 3D render', version: 'Version 2' },
    { title: 'Material and finish board', version: 'Version 1' },
    { title: 'Revised layout after site visit', version: 'Version 3' },
  ],
  materials: [
    { title: '18 mm BWP plywood, 40 sheets', vendor: 'Sri Balaji Traders', quantity: '40 sheets', amount: 112000 },
    { title: 'Hettich soft-close hinges', vendor: 'Hettich India', quantity: '160 nos', amount: 48000 },
    { title: 'Italian marble, 1,200 sq ft', vendor: 'Marble House', quantity: '1,200 sq ft', amount: 384000 },
    { title: 'Pendant lights, dining', vendor: 'Lumen Lights', quantity: '6 nos', amount: 54000 },
  ],
  snags: [
    { title: 'Laminate chipped on wardrobe shutter', location: 'Master bedroom', severity: 'high', photos: 3 },
    { title: 'Paint touch-up near switchboard', location: 'Living', severity: 'low', photos: 1 },
    { title: 'Kitchen drawer channel misaligned', location: 'Kitchen', severity: 'medium', photos: 2 },
  ],
  changes: [
    { title: 'Add a second wardrobe in bedroom 2', amount: 145000, daysImpact: 6 },
    { title: 'Upgrade to engineered wood flooring', amount: 220000, daysImpact: 4 },
  ],
  vendors: [
    { title: 'Stage Craft', category: 'Fabrication', amount: 480000, advance: 150000 },
    { title: 'Sound Pro Rentals', category: 'Sound', amount: 165000, advance: 50000 },
    { title: 'Royal Caterers', category: 'Catering', amount: 620000, advance: 200000 },
    { title: 'Shree Transport', category: 'Transport', amount: 85000, advance: 0 },
  ],
  deliverables: [
    { title: 'Instagram carousel, week 2', channel: 'Instagram' },
    { title: 'Search ad copy refresh', channel: 'Google Ads' },
    { title: 'Landing page A/B test', channel: 'Website' },
    { title: 'Monthly performance report', channel: 'Email' },
  ],
  rights: [
    { title: 'Stock photo pack', licenceType: 'Images', scope: 'Digital only' },
    { title: 'Font licence, display family', licenceType: 'Font', scope: 'One year' },
  ],
  visits: [
    { title: 'Q1 preventive maintenance, block A', site: 'Block A, ground floor', sla: 'met' },
    { title: 'Breakdown call, unit 12', site: 'OPD wing', sla: 'met' },
    { title: 'Filter replacement round', site: 'Cafeteria', sla: 'breached' },
  ],
  drawings: [
    { title: 'Ground floor plan', drawingNo: 'A-101', revision: 'R2' },
    { title: 'Elevation, north', drawingNo: 'A-204', revision: 'R1' },
    { title: 'Section A-A', drawingNo: 'A-301', revision: 'R0' },
  ],
  deadlines: [
    { title: 'Building plan sanction', authority: 'BBMP' },
    { title: 'Fire NOC', authority: 'Fire department' },
  ],
  shoot: [{ title: 'Day 1, studio', location: 'Studio 4, Film City', callTime: '7:00 am', crew: 18 }],
  dpr: [{ title: 'Slab casting, 3rd floor' }],
  sessions: [{ title: 'Module 1, fundamentals' }],
  docs: [{ title: 'Bank statements, Apr–Mar' }],
};

const pick = (arr, i) => arr[i % arr.length];

async function seedCompany(company, plan) {
  const log = (...a) => console.log(`  ${a.join(' ')}`);
  console.log(`\n=== ${company.name} (${company.code}) ===`);

  // ---- templates -----------------------------------------------------------
  const haveT = await ProjectTemplate.find({ companyId: company._id }).lean();
  const haveKeys = new Set(haveT.map((t) => t.key));
  const missing = BLUEPRINTS.filter((b) => !haveKeys.has(b.key));
  if (missing.length) {
    await ProjectTemplate.insertMany(missing.map((b) => ({ companyId: company._id, ...toTemplate(b) })));
    log(`templates: +${missing.length}`);
  }
  const templates = new Map((await ProjectTemplate.find({ companyId: company._id }).lean()).map((t) => [t.key, t]));

  const clients = await Client.find({ companyId: company._id, isDeleted: false }).lean();
  const employees = await Employee.find({ companyId: company._id, isDeleted: false, status: 'active' })
    .select('_id employeeCode personal.firstName personal.lastName salary.ctc job.designationId')
    .lean();
  if (!employees.length) { log('no active employees — skipping'); return; }
  const admin = await User.findOne({ companyId: company._id, role: { $in: ['company_admin', 'hr_admin'] } }).select('_id').lean();

  let madeProjects = 0;
  let madeTasks = 0;
  let madeTs = 0;
  let madeMods = 0;

  for (let pi = 0; pi < plan.length; pi += 1) {
    const spec = plan[pi];
    const r = rng(pi * 7919 + company.code.charCodeAt(0));
    const template = templates.get(spec.tmpl);
    const start = today.subtract(spec.elapsed, 'day');
    const end = start.add(spec.days, 'day');

    const progress = spec.shape === 'done' ? 100 : clamp(Math.round((spec.elapsed / spec.days) * 100 * PACE[spec.shape]), 4, 97);
    const budget = Math.round((spec.value * 0.66) / 1000) * 1000;
    const status = spec.shape === 'hold' ? 'on_hold' : spec.shape === 'done' ? 'completed' : 'active';

    const n = template.phases.length;
    const phaseIdx = spec.shape === 'done' ? n - 1 : clamp(Math.floor((progress / 100) * n), 0, n - 1);
    const phases = template.phases.map((ph, k) => ({
      name: ph.name,
      gate: ph.gate,
      startDate: start.add(Math.round((k * spec.days) / n), 'day').toDate(),
      endDate: start.add(Math.round(((k + 1) * spec.days) / n) - 1, 'day').toDate(),
      // Only phases genuinely behind us are marked complete.
      completedAt: k < phaseIdx || spec.shape === 'done' ? start.add(Math.round(((k + 1) * spec.days) / n), 'day').toDate() : null,
      signedOffAt: ph.gate && (k < phaseIdx || spec.shape === 'done')
        ? start.add(Math.round(((k + 1) * spec.days) / n), 'day').toDate()
        : null,
      signedOffBy: ph.gate && k < phaseIdx ? (clients[pi % clients.length] || {}).contactPerson || 'Client' : null,
    }));

    const manager = pick(employees, pi);
    const members = employees.slice(pi % Math.max(1, employees.length - 5), (pi % Math.max(1, employees.length - 5)) + 4 + (pi % 3));

    const fields = {
      companyId: company._id,
      name: spec.name,
      code: `${template.code}-${String(pi + 1).padStart(3, '0')}`,
      clientId: clients.length ? clients[pi % clients.length]._id : null,
      description: `${template.name} engagement for ${(clients[pi % clients.length] || {}).name || 'the client'}.`,
      status,
      startDate: start.toDate(),
      endDate: end.toDate(),
      managerId: manager._id,
      members: members.map((m) => m._id),
      templateId: template._id,
      phases,
      currentPhase: phaseIdx,
      contractValue: spec.value,
      budget,
      billingType: template.billing,
      holdReason: spec.shape === 'hold' ? 'Client payment pending' : null,
      heldAt: spec.shape === 'hold' ? today.subtract(18, 'day').toDate() : null,
    };

    // Idempotent on name: update the plan fields, create only when absent.
    let project = await Project.findOne({ companyId: company._id, name: spec.name });
    if (project) {
      Object.assign(project, fields);
      await project.save();
    } else {
      project = await Project.create(fields);
      madeProjects += 1;
    }

    // ---- tasks: the source of truth for progress --------------------------
    const titles = TASK_TITLES[spec.tmpl] || TASK_TITLES.web;
    const wantDone = Math.round((progress / 100) * titles.length);
    for (let k = 0; k < titles.length; k += 1) {
      const done = k < wantDone;
      const due = start.add(Math.round(((k + 1) * spec.days) / titles.length), 'day');
      const payload = {
        companyId: company._id,
        projectId: project._id,
        title: titles[k],
        assignedTo: pick(members.length ? members : employees, k)._id,
        assignedBy: admin ? admin._id : undefined,
        dueDate: due.toDate(),
        phaseIndex: clamp(Math.floor((k / titles.length) * n), 0, n - 1),
        estimateHours: [8, 12, 16, 24, 32][k % 5],
        status: done ? 'completed' : due.isBefore(today) ? 'in_progress' : 'todo',
        completedAt: done ? due.toDate() : null,
      };
      const existing = await Task.findOne({ companyId: company._id, projectId: project._id, title: titles[k] });
      if (existing) { Object.assign(existing, payload); await existing.save(); }
      else if (admin) { await Task.create(payload); madeTasks += 1; }
    }

    if (status === 'completed') continue; // a closed project needs no fresh activity

    // ---- timesheets, priced so cost lands on the burn target ---------------
    // Hours are only ever logged on days the person was ACTUALLY present, and
    // never beyond the hours they were there. Otherwise every clean entry would
    // trip the attendance reconciliation and the flagged ones would mean
    // nothing — the deliberate mismatches are added separately, further down.
    const crew = members.length ? members : employees.slice(0, 4);
    const rateOf = (e) => ((e.salary && e.salary.ctc) || 600000) / 12 / 26 / 8;
    const labourTarget = budget * (progress / 100) * BURN[spec.shape] * (['interior', 'events'].includes(spec.tmpl) ? 0.45 : 0.9);
    const avgRate = crew.reduce((a, e) => a + rateOf(e), 0) / crew.length;

    const spent = await Timesheet.aggregate([
      { $match: { companyId: company._id, projectId: project._id, status: { $ne: 'rejected' } } },
      { $group: { _id: null, hours: { $sum: '$hours' } } },
    ]);
    let left = Math.max(0, Math.round(labourTarget / avgRate) - ((spent[0] || {}).hours || 0));

    if (left > 0) {
      // Workable days for this crew, from the punch record.
      const present = await Attendance.find({
        companyId: company._id,
        employeeId: { $in: crew.map((e) => e._id) },
        status: { $in: ['present', 'late', 'wfh', 'half_day'] },
        totalHours: { $gt: 0 },
        date: { $gte: iso(start), $lte: iso(today) },
      })
        .select('employeeId date totalHours')
        .sort({ date: -1 })
        .lean();

      // What each person has already booked that day, on any project.
      const booked = new Map();
      for (const t of await Timesheet.find({
        companyId: company._id,
        employeeId: { $in: crew.map((e) => e._id) },
        date: { $in: [...new Set(present.map((a) => a.date))] },
        status: { $ne: 'rejected' },
      }).select('employeeId date hours').lean()) {
        const k = `${t.employeeId}|${t.date}`;
        booked.set(k, (booked.get(k) || 0) + t.hours);
      }

      const entries = [];
      for (const a of present) {
        if (left <= 0) break;
        if (r() < 0.35) continue; // not everyone logs to this project every day
        const k = `${a.employeeId}|${a.date}`;
        const free = Math.floor((a.totalHours - (booked.get(k) || 0)) * 2) / 2;
        if (free < 1) continue;
        const take = Math.min(free, left, [2, 3, 4, 6, 8][Math.floor(r() * 5)]);
        if (take < 1) continue;
        booked.set(k, (booked.get(k) || 0) + take);
        left -= take;
        entries.push({
          companyId: company._id,
          employeeId: a.employeeId,
          projectId: project._id,
          date: a.date,
          hours: take,
          note: pick(titles, entries.length),
          billable: r() < 0.82,
          status: r() < 0.55 ? 'approved' : 'submitted',
        });
      }
      if (entries.length) { await Timesheet.insertMany(entries); madeTs += entries.length; }
    }

    // ---- module rows -------------------------------------------------------
    for (const mod of template.modules) {
      const rows = MODULE_ROWS[mod] || [];
      for (let k = 0; k < rows.length; k += 1) {
        const base = rows[k];
        const exists = await ProjectModuleItem.findOne({ companyId: company._id, projectId: project._id, module: mod, title: base.title }).select('_id').lean();

        const { title, amount = 0, daysImpact = 0, ...data } = base;
        // Committed spend counts toward project cost, so it has to be sized to
        // the project — a fixed ₹5 L purchase order would swallow a small
        // contract's whole budget and make burn nonsense.
        const scaled = amount ? Math.round((amount * (budget / 2000000)) / 1000) * 1000 : 0;
        const doc = {
          companyId: company._id,
          projectId: project._id,
          module: mod,
          title,
          amount: scaled,
          daysImpact,
          ownerId: pick(crew, k)._id,
          data,
          status: 'open',
          dueDate: null,
        };

        if (mod === 'approvals') {
          if (k === 0 && spec.shape === 'waiting') {
            // The one the client has been sitting on — 9 days, past the 5-day line.
            doc.sentOn = today.subtract(9, 'day').toDate();
            doc.status = 'waiting_on_client';
          } else if (k === 0) {
            doc.sentOn = today.subtract(2, 'day').toDate();
            doc.status = 'waiting_on_client';
          } else {
            doc.sentOn = today.subtract(30 + k * 6, 'day').toDate();
            doc.decidedOn = today.subtract(27 + k * 6, 'day').toDate();
            doc.status = k === 2 ? 'rejected' : 'approved';
            doc.completedAt = doc.decidedOn;
          }
        } else if (mod === 'materials') {
          doc.dueDate = today.add(k * 5 - 4, 'day').toDate();
          doc.status = k < 2 ? 'delivered' : k === 2 ? 'in_transit' : 'ordered';
          if (k < 2) doc.completedAt = doc.dueDate;
        } else if (mod === 'snags') {
          doc.status = k === 2 ? 'closed' : 'open';
          if (k === 2) doc.completedAt = today.subtract(3, 'day').toDate();
        } else if (mod === 'changes') {
          doc.sentOn = today.subtract(12 - k * 4, 'day').toDate();
          if (k === 0) { doc.status = 'approved'; doc.decidedOn = today.subtract(8, 'day').toDate(); doc.completedAt = doc.decidedOn; }
          else doc.status = 'waiting_on_client';
        } else if (mod === 'vendors') {
          doc.status = k < 2 ? 'confirmed' : k === 2 ? 'advance_due' : 'pending';
          if (doc.data.advance) doc.data.advance = Math.round((doc.data.advance * (budget / 2000000)) / 1000) * 1000;
        } else if (mod === 'deliverables') {
          doc.dueDate = today.add(k * 6 - 5, 'day').toDate();
          doc.status = k === 0 ? 'delivered' : k === 3 ? 'overdue' : 'in_progress';
          if (k === 0) doc.completedAt = doc.dueDate;
        } else if (mod === 'rights') {
          // One licence expiring inside the 30-day warning window.
          doc.dueDate = today.add(k === 0 ? 18 : 240, 'day').toDate();
          doc.status = k === 0 ? 'expiring_soon' : 'valid';
        } else if (mod === 'visits') {
          doc.dueDate = today.add(k * 9 - 6, 'day').toDate();
          doc.status = k === 0 ? 'done' : k === 2 ? 'overdue' : 'scheduled';
          if (k === 0) doc.completedAt = doc.dueDate;
        } else if (mod === 'drawings') {
          doc.status = k === 2 ? 'draft' : 'issued';
          doc.data.issuedOn = iso(today.subtract(20 + k * 7, 'day'));
        } else if (mod === 'deadlines') {
          doc.dueDate = today.add(k === 0 ? 12 : 40, 'day').toDate();
          doc.status = k === 0 ? 'in_progress' : 'upcoming';
        } else {
          doc.dueDate = today.add(k * 7 - 3, 'day').toDate();
          doc.status = 'scheduled';
        }
        if (exists) {
          // Refresh the planned fields on a row we already wrote. Amounts in
          // particular are scaled to the project, so a re-run after a budget
          // change has to restate them or committed spend stays wrong.
          await ProjectModuleItem.updateOne({ _id: exists._id }, {
            $set: {
              amount: doc.amount,
              daysImpact: doc.daysImpact,
              status: doc.status,
              dueDate: doc.dueDate || null,
              sentOn: doc.sentOn || null,
              decidedOn: doc.decidedOn || null,
              completedAt: doc.completedAt || null,
              data: doc.data,
            },
          });
          continue;
        }
        await ProjectModuleItem.create(doc);
        madeMods += 1;
      }
    }
  }

  // ---- genuine timesheet mismatches ---------------------------------------
  // Find days people were actually on leave or absent and log hours there, so
  // the reconciliation flags them on the real record rather than a fake marker.
  const liveProjects = await Project.find({ companyId: company._id, status: 'active', isDeleted: false }).select('_id').lean();
  if (liveProjects.length) {
    const offDays = await Attendance.find({
      companyId: company._id,
      status: { $in: ['on_leave', 'absent'] },
      date: { $gte: iso(today.subtract(45, 'day')) },
    })
      .select('employeeId date status')
      .limit(4)
      .lean();
    let flagged = 0;
    for (let k = 0; k < offDays.length; k += 1) {
      const a = offDays[k];
      const projectId = liveProjects[k % liveProjects.length]._id;
      const exists = await Timesheet.findOne({ companyId: company._id, employeeId: a.employeeId, projectId, date: a.date }).select('_id').lean();
      if (exists) continue;
      await Timesheet.create({
        companyId: company._id,
        employeeId: a.employeeId,
        projectId,
        date: a.date,
        hours: 6,
        note: 'Catch-up work',
        billable: true,
        status: 'submitted',
      });
      flagged += 1;
      madeTs += 1;
    }
    if (flagged) log(`timesheets on leave/absent days (will be flagged): ${flagged}`);
  }

  log(`projects +${madeProjects}, tasks +${madeTasks}, timesheets +${madeTs}, module rows +${madeMods}`);
}

(async () => {
  const only = process.argv[2];
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('connected:', mongoose.connection.host, '/', mongoose.connection.name);

  const companies = await Company.find({ isDeleted: false }).lean();
  for (const c of companies) {
    const plan = PLAN[c.code];
    if (!plan) { console.log(`\n(skipping ${c.name} — no demo plan for code ${c.code})`); continue; }
    if (only && c.code !== only) continue;
    await seedCompany(c, plan);
  }

  await mongoose.disconnect();
  console.log('\ndone.');
})().catch((e) => {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
