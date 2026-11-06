const router = require('express').Router();
const controller = require('../controllers/exit.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { audit } = require('../middleware/audit');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.EXIT_MANAGEMENT));

router.post('/', controller.applyResignation);
router.get('/', controller.listResignations);
router.get('/:id', controller.getResignation);
router.patch('/:id/manager-review', requireRole(ROLES.MANAGER, ...HR), controller.managerReview);
router.patch('/:id/hr-review', requireRole(...HR), controller.hrReview);
router.post('/:id/approve', requireRole(ROLES.MANAGER, ...HR), controller.approveResignation); // stage-aware alias
router.post('/:id/reject', requireRole(ROLES.MANAGER, ...HR), controller.rejectResignation);
router.patch('/:id/checklist', requireRole(...HR), controller.updateChecklist);
router.put('/:id/checklist', requireRole(...HR), controller.updateChecklist); // admin panel alias
router.post('/:id/complete', requireRole(...HR), audit('exit.complete', 'Resignation'), controller.completeExit);
router.patch('/:id/withdraw', controller.withdrawResignation);

module.exports = router;
