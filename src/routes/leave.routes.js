const router = require('express').Router();
const controller = require('../controllers/leave.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const APPROVERS = [ROLES.MANAGER, ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.LEAVE));

router.post('/', controller.applyLeave);
router.get('/', controller.listLeaves);
router.get('/balance', controller.getBalance);
router.get('/balances', requireRole(...APPROVERS), controller.listBalances); // before any /:id routes
router.patch('/:id/approve', requireRole(...APPROVERS), controller.approveLeave);
router.patch('/:id/reject', requireRole(...APPROVERS), controller.rejectLeave);
router.patch('/:id/cancel', controller.cancelLeave);

module.exports = router;
