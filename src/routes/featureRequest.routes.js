const router = require('express').Router();
const controller = require('../controllers/featureRequest.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { ROLES } = require('../constants');

router.use(auth, subscriptionCheck);

router.post('/', requireRole(ROLES.COMPANY_ADMIN), controller.createRequest);
router.get('/', requireRole(ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN), controller.listRequests);
router.get('/:id', requireRole(ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN), controller.getRequest);
router.patch('/:id/status', requireRole(ROLES.SUPER_ADMIN), controller.updateStatus);

module.exports = router;
