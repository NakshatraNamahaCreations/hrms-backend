const router = require('express').Router();
const controller = require('../controllers/workAssignment.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { upload } = require('../middleware/upload');
const { ROLES, FEATURES } = require('../constants');

const MANAGERS = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.MANAGER, ROLES.SUPER_ADMIN];
// Any assignable employee (office or field) — a job team can include both.
const TEAM = [ROLES.FIELD_EMPLOYEE, ROLES.EMPLOYEE];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.CLIENT_WORK_ASSIGNMENT));

router.get('/my', requireRole(...TEAM), controller.myAssignments);
// Profit views are for the company owner only.
router.get('/profitability', requireRole(ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN), controller.profitability);
router.get('/', requireRole(...MANAGERS, ...TEAM), controller.listAssignments);
router.post('/', requireRole(...MANAGERS), upload.array('attachments', 5), controller.createAssignment);
router.get('/:id', requireRole(...MANAGERS, ...TEAM), controller.getAssignment);
router.put('/:id', requireRole(...MANAGERS), controller.updateAssignment);
router.patch('/:id/status', requireRole(...MANAGERS, ...TEAM), controller.updateStatus);
router.post('/:id/status', requireRole(...MANAGERS, ...TEAM), controller.updateStatus); // mobile alias
router.post('/:id/accept', requireRole(...TEAM), controller.acceptAssignment);
router.post('/:id/reject', requireRole(...TEAM), controller.rejectAssignment);
// Per-member check-in / check-out on the job (per-job timesheet).
router.post('/:id/checkin', requireRole(...MANAGERS, ...TEAM), controller.checkInJob);
router.post('/:id/checkout', requireRole(...MANAGERS, ...TEAM), controller.checkOutJob);
router.patch('/:id/checklist', requireRole(...MANAGERS, ...TEAM), controller.updateChecklist);
router.patch('/:id/costing', requireRole(ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN), controller.setCosting);
router.delete('/:id', requireRole(...MANAGERS), controller.deleteAssignment);

module.exports = router;
