const router = require('express').Router();
const controller = require('../controllers/attendance.controller');
const corrections = require('../controllers/attendanceCorrection.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { audit } = require('../middleware/audit');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN];
const APPROVERS = [...HR, ROLES.MANAGER];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.ATTENDANCE));

// ---- corrections (mounted before param routes) ----------------------------
router.post('/corrections', corrections.createCorrection);
router.get('/corrections', corrections.listCorrections);
router.get('/corrections/pending', requireRole(...APPROVERS), corrections.pendingForApprover);
router.patch('/corrections/:id/approve', requireRole(ROLES.MANAGER, ...HR), corrections.managerApprove);
router.patch('/corrections/:id/verify', requireRole(...HR), corrections.hrVerify);
router.patch('/corrections/:id/reject', requireRole(...APPROVERS), corrections.rejectCorrection);

// ---- attendance ------------------------------------------------------------
router.post('/check-in', controller.checkIn);
router.post('/check-out', controller.checkOut);
router.get('/today', controller.getToday);
router.get('/summary', controller.monthlySummary);
router.post('/manual', requireRole(...HR), audit('attendance.manual_mark', 'Attendance'), controller.manualMark);
router.get('/', controller.listAttendance);

module.exports = router;
