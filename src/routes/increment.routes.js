const router = require('express').Router();
const controller = require('../controllers/increment.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { audit } = require('../middleware/audit');
const { ROLES, FEATURES } = require('../constants');

const ADMINS = [ROLES.HR_ADMIN, ROLES.PAYROLL_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.PAYROLL));

router.get('/', controller.listRequests); // admins all, employees own — scoped in controller
router.post('/', audit('increment.request', 'IncrementRequest'), controller.submitRequest);
router.patch('/:id/under-review', requireRole(...ADMINS), controller.markUnderReview);
router.patch('/:id/approve', requireRole(...ADMINS), controller.approveRequest);
router.patch('/:id/reject', requireRole(...ADMINS), controller.rejectRequest);

module.exports = router;
