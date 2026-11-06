// Single source of truth for roles, feature flags and status enums.
// All values mirror ARCHITECTURE.md exactly.

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  COMPANY_ADMIN: 'company_admin',
  HR_ADMIN: 'hr_admin',
  MANAGER: 'manager',
  EMPLOYEE: 'employee',
  FIELD_EMPLOYEE: 'field_employee',
  PAYROLL_ADMIN: 'payroll_admin',
};
const ROLE_VALUES = Object.values(ROLES);

const FEATURES = {
  EMPLOYEE_MANAGEMENT: 'employeeManagement',
  ATTENDANCE: 'attendance',
  LEAVE: 'leave',
  PAYROLL: 'payroll',
  BIOMETRIC: 'biometric',
  FIELD_TRACKING: 'fieldTracking',
  CLIENT_WORK_ASSIGNMENT: 'clientWorkAssignment',
  LIVE_LOCATION_TRACKING: 'liveLocationTracking',
  GEO_ATTENDANCE: 'geoAttendance',
  SELFIE_ATTENDANCE: 'selfieAttendance',
  RECRUITMENT: 'recruitment',
  ONBOARDING: 'onboarding',
  PERFORMANCE: 'performance',
  ASSET_MANAGEMENT: 'assetManagement',
  CUSTOM_REPORTS: 'customReports',
  WHATSAPP_NOTIFICATION: 'whatsappNotification',
  EXIT_MANAGEMENT: 'exitManagement',
  EXPENSE_MANAGEMENT: 'expenseManagement',
  CLIENT_SIGNATURE: 'clientSignature',
  DOCUMENTS: 'documents',
  TICKETS: 'tickets',
  ANNOUNCEMENTS: 'announcements',
  TASKS: 'tasks',
  SHIFTS: 'shifts',
  HOLIDAYS: 'holidays',
  LOANS: 'loans',
  PROJECTS: 'projects',
  HR_POLICIES: 'hrPolicies',
  TRAINING: 'training',
};
const FEATURE_KEYS = Object.values(FEATURES);

const SUBSCRIPTION_STATUS = ['trial', 'active', 'payment_due', 'expired', 'suspended'];

const ATTENDANCE_STATUS = [
  'present', 'absent', 'half_day', 'late', 'early_exit', 'wfh', 'on_leave', 'holiday', 'week_off',
];

const ATTENDANCE_SOURCE = [
  'manual', 'employee_app', 'web', 'biometric', 'excel_import', 'admin_correction', 'field_visit',
];

const WORK_ASSIGNMENT_STATUS = [
  'assigned', 'accepted', 'rejected', 'on_the_way', 'reached', 'checked_in',
  'in_progress', 'on_hold', 'completed', 'checked_out', 'cancelled', 'rescheduled',
];

// Allowed work-assignment status transitions
const WORK_ASSIGNMENT_TRANSITIONS = {
  // 'on_the_way' allowed directly from 'assigned': employees do not accept/decline
  assigned: ['accepted', 'rejected', 'on_the_way', 'cancelled', 'rescheduled'],
  accepted: ['on_the_way', 'cancelled', 'rescheduled'],
  rejected: ['assigned', 'rescheduled', 'cancelled'],
  on_the_way: ['reached', 'cancelled'],
  reached: ['checked_in', 'cancelled'],
  checked_in: ['in_progress'],
  in_progress: ['completed', 'on_hold'],
  // Admin can pause a job and resume it later.
  on_hold: ['in_progress', 'assigned', 'completed', 'cancelled'],
  // A finished job can be REOPENED for more work (bug fixes / new scope) — the
  // members' workDays are preserved, so days keep accumulating (5 → 6 → 7).
  completed: ['checked_out', 'in_progress'],
  checked_out: ['in_progress'],
  cancelled: [],
  rescheduled: ['assigned'],
};

const LEAVE_STATUS = ['pending', 'approved', 'rejected', 'cancelled'];
const LEAVE_TYPES = ['casual', 'sick', 'earned', 'unpaid'];

const PAYROLL_STATUS = ['draft', 'under_review', 'approved', 'paid', 'locked'];

const TICKET_STATUS = ['open', 'in_progress', 'waiting_for_employee', 'resolved', 'closed'];
const TICKET_TRANSITIONS = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['waiting_for_employee', 'resolved', 'closed'],
  waiting_for_employee: ['in_progress', 'resolved', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};
const TICKET_CATEGORIES = ['it', 'hr', 'payroll', 'admin', 'other'];

const ONBOARDING_STATUS = ['pending', 'document_submitted', 'verified', 'active'];

const FEATURE_REQUEST_STATUS = [
  'requested', 'under_review', 'quotation_sent', 'approved',
  'in_development', 'testing', 'completed', 'rejected',
];
const FEATURE_REQUEST_TRANSITIONS = {
  requested: ['under_review', 'rejected'],
  under_review: ['quotation_sent', 'approved', 'rejected'],
  quotation_sent: ['approved', 'rejected'],
  approved: ['in_development', 'rejected'],
  in_development: ['testing'],
  testing: ['completed', 'in_development'],
  completed: [],
  rejected: [],
};

const EXPENSE_STATUS = ['submitted', 'approved', 'rejected', 'paid'];
const PROOF_STATUS = ['submitted', 'verified', 'rejected'];

const EMPLOYEE_TYPES = ['office_employee', 'field_employee'];
const EMPLOYEE_STATUS = ['active', 'inactive', 'exited'];

const CANDIDATE_STATUS = ['applied', 'screening', 'shortlisted', 'interview', 'offered', 'hired', 'rejected'];
const TASK_STATUS = ['todo', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const ASSET_STATUS = ['available', 'assigned', 'in_repair', 'retired'];
const DOCUMENT_STATUS = ['pending', 'verified', 'rejected'];
const RESIGNATION_STATUS = [
  'applied', 'manager_approved', 'hr_approved', 'checklist_in_progress', 'completed', 'rejected', 'withdrawn',
];
const CORRECTION_STATUS = ['pending', 'manager_approved', 'approved', 'rejected'];
const PAYMENT_STATUS = ['created', 'paid', 'failed', 'refunded'];
const BILLING_CYCLES = ['monthly', 'yearly', 'trial'];
const LETTER_TYPES = ['offer', 'appointment', 'experience', 'relieving', 'salary_certificate', 'confirmation', 'increment'];
const COMPANY_STATUS = ['active', 'suspended', 'inactive'];

// --- Loans & Advances ---------------------------------------------------------
const LOAN_STATUS = ['requested', 'approved', 'rejected', 'disbursed', 'closed'];
const LOAN_TYPES = ['loan', 'advance'];
const LOAN_PAYMENT_METHODS = ['payroll', 'cash', 'bank_transfer', 'upi', 'cheque', 'other'];

// --- Probation ------------------------------------------------------------------
const CONFIRMATION_STATUS = ['probation', 'confirmed'];

// --- Projects & Timesheets ------------------------------------------------------
const PROJECT_STATUS = ['active', 'on_hold', 'completed'];
const TIMESHEET_STATUS = ['submitted', 'approved', 'rejected'];

// --- Training ---------------------------------------------------------------------
const COURSE_TYPES = ['video', 'pdf', 'link'];
const ASSIGNMENT_STATUS = ['assigned', 'completed'];

// --- Increment Requests -------------------------------------------------------------
const INCREMENT_STATUS = ['requested', 'under_review', 'approved', 'rejected'];

module.exports = {
  ROLES,
  ROLE_VALUES,
  FEATURES,
  FEATURE_KEYS,
  SUBSCRIPTION_STATUS,
  ATTENDANCE_STATUS,
  ATTENDANCE_SOURCE,
  WORK_ASSIGNMENT_STATUS,
  WORK_ASSIGNMENT_TRANSITIONS,
  LEAVE_STATUS,
  LEAVE_TYPES,
  PAYROLL_STATUS,
  TICKET_STATUS,
  TICKET_TRANSITIONS,
  TICKET_CATEGORIES,
  ONBOARDING_STATUS,
  FEATURE_REQUEST_STATUS,
  FEATURE_REQUEST_TRANSITIONS,
  EXPENSE_STATUS,
  PROOF_STATUS,
  EMPLOYEE_TYPES,
  EMPLOYEE_STATUS,
  CANDIDATE_STATUS,
  TASK_STATUS,
  ASSET_STATUS,
  DOCUMENT_STATUS,
  RESIGNATION_STATUS,
  CORRECTION_STATUS,
  PAYMENT_STATUS,
  BILLING_CYCLES,
  LETTER_TYPES,
  COMPANY_STATUS,
  LOAN_STATUS,
  LOAN_TYPES,
  LOAN_PAYMENT_METHODS,
  CONFIRMATION_STATUS,
  PROJECT_STATUS,
  TIMESHEET_STATUS,
  COURSE_TYPES,
  ASSIGNMENT_STATUS,
  INCREMENT_STATUS,
};
