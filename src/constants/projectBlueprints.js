/**
 * Industry blueprints shipped with the product. A company gets a copy of these
 * as ProjectTemplate rows the first time it opens Projects, after which they
 * are the company's own to edit — these definitions are never read again for a
 * template that already exists.
 *
 * `gates` are the phase indexes a client must sign off before the project can
 * move past them.
 */
const BLUEPRINTS = [
  {
    key: 'interior',
    name: 'Interior design and fit-out',
    code: 'INT',
    vocab: { project: 'Project', projects: 'Projects', item: 'Work item', items: 'Work items', newLabel: 'New project' },
    phases: ['Site survey', 'Concept and 3D', 'Client sign-off', 'Procurement', 'Execution', 'Snagging', 'Handover'],
    gates: [2, 6],
    modules: ['approvals', 'materials', 'snags', 'changes'],
    billing: 'milestone',
  },
  {
    key: 'adfilm',
    name: 'Ad film and video production',
    code: 'PRD',
    vocab: { project: 'Production', projects: 'Productions', item: 'Shot', items: 'Shot list', newLabel: 'New production' },
    phases: ['Brief', 'Script and storyboard', 'Pre-production', 'Shoot', 'Edit and grade', 'Client review', 'Delivery'],
    gates: [1, 5],
    modules: ['shoot', 'approvals', 'rights', 'vendors'],
    billing: 'fixed_fee',
  },
  {
    key: 'web',
    name: 'Software and web development',
    code: 'PRJ',
    vocab: { project: 'Project', projects: 'Projects', item: 'Task', items: 'Tasks', newLabel: 'New project' },
    phases: ['Discovery', 'UX and design', 'Development', 'QA', 'UAT', 'Launch', 'Hypercare'],
    gates: [1, 4],
    modules: ['approvals', 'changes', 'rights'],
    billing: 'milestone',
  },
  {
    key: 'architecture',
    name: 'Architecture',
    code: 'ARC',
    vocab: { project: 'Project', projects: 'Projects', item: 'Deliverable', items: 'Deliverables', newLabel: 'New project' },
    phases: ['Concept', 'Schematic design', 'Design development', 'Statutory approval', 'Working drawings', 'Site supervision'],
    gates: [0, 2],
    modules: ['drawings', 'deadlines', 'approvals', 'changes'],
    billing: 'percentage',
  },
  {
    key: 'construction',
    name: 'Construction and civil contracting',
    code: 'CON',
    vocab: { project: 'Site', projects: 'Sites', item: 'Activity', items: 'Activities', newLabel: 'New site' },
    phases: ['Mobilisation', 'Foundation', 'Structure', 'Masonry', 'MEP', 'Finishing', 'Handover'],
    gates: [2, 6],
    modules: ['dpr', 'materials', 'snags', 'changes'],
    billing: 'running_account',
  },
  {
    key: 'events',
    name: 'Event management',
    code: 'EVT',
    vocab: { project: 'Event', projects: 'Events', item: 'Task', items: 'Run sheet', newLabel: 'New event' },
    phases: ['Brief', 'Concept and budget', 'Venue and vendors', 'Production', 'Rehearsal', 'Event day', 'Settlement'],
    gates: [1, 6],
    modules: ['vendors', 'approvals', 'changes'],
    billing: 'advance_settlement',
  },
  {
    key: 'marketing',
    name: 'Marketing and creative agency',
    code: 'RET',
    vocab: { project: 'Account', projects: 'Accounts', item: 'Deliverable', items: 'Deliverables', newLabel: 'New account' },
    phases: ['Onboarding', 'Strategy', 'Month 1', 'Month 2', 'Month 3', 'Quarterly review'],
    gates: [1, 5],
    modules: ['deliverables', 'approvals', 'rights'],
    billing: 'retainer',
  },
  {
    key: 'photo',
    name: 'Photography studio',
    code: 'SHT',
    vocab: { project: 'Booking', projects: 'Bookings', item: 'Deliverable', items: 'Deliverables', newLabel: 'New booking' },
    phases: ['Booking', 'Pre-shoot call', 'Shoot', 'Culling', 'Editing', 'Album design', 'Delivery'],
    gates: [5, 6],
    modules: ['shoot', 'approvals', 'deliverables'],
    billing: 'package',
  },
  {
    key: 'fabrication',
    name: 'Fabrication and manufacturing',
    code: 'JOB',
    vocab: { project: 'Job order', projects: 'Job orders', item: 'Operation', items: 'Operations', newLabel: 'New job order' },
    phases: ['Order received', 'Drawing approval', 'Material', 'Fabrication', 'QC', 'Dispatch', 'Installation'],
    gates: [1, 4],
    modules: ['drawings', 'materials', 'snags'],
    billing: 'per_unit',
  },
  {
    key: 'ca',
    name: 'Accounting and legal firms',
    code: 'ENG',
    vocab: { project: 'Engagement', projects: 'Engagements', item: 'Task', items: 'Tasks', newLabel: 'New engagement' },
    phases: ['Engagement letter', 'Data collection', 'Working', 'Review', 'Filing', 'Closure'],
    gates: [0, 3],
    modules: ['deadlines', 'docs', 'approvals'],
    billing: 'fixed_fee',
  },
  {
    key: 'training',
    name: 'Training and education',
    code: 'BAT',
    vocab: { project: 'Program', projects: 'Programs', item: 'Session', items: 'Sessions', newLabel: 'New program' },
    phases: ['Curriculum', 'Enrolment', 'Delivery', 'Assessment', 'Certification'],
    gates: [0, 4],
    modules: ['sessions', 'deliverables', 'approvals'],
    billing: 'per_learner',
  },
  {
    key: 'facility',
    name: 'Facility and maintenance services',
    code: 'AMC',
    vocab: { project: 'Contract', projects: 'Contracts', item: 'Job', items: 'Jobs', newLabel: 'New contract' },
    phases: ['Onboarding', 'Q1 service', 'Q2 service', 'Q3 service', 'Q4 service', 'Renewal'],
    gates: [5],
    modules: ['visits', 'materials', 'rights'],
    billing: 'annual_contract',
  },
];

/** Blueprint → the shape ProjectTemplate stores. */
const toTemplate = (bp) => ({
  key: bp.key,
  name: bp.name,
  code: bp.code,
  vocab: bp.vocab,
  phases: bp.phases.map((name, i) => ({ name, gate: bp.gates.includes(i) })),
  modules: bp.modules,
  billing: bp.billing,
});

const BILLING_LABELS = {
  milestone: 'Milestone billing',
  fixed_fee: 'Fixed fee',
  percentage: 'Percentage of construction cost',
  running_account: 'Running account bills',
  advance_settlement: 'Advance plus settlement',
  retainer: 'Monthly retainer',
  package: 'Package',
  per_unit: 'Per unit',
  per_learner: 'Per learner',
  annual_contract: 'Annual contract',
};

module.exports = { BLUEPRINTS, toTemplate, BILLING_LABELS };
