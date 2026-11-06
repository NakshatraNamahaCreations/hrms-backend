const router = require('express').Router();
const controller = require('../controllers/finance.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { ROLES } = require('../constants');

// Owner-only Profit Intelligence / Finance. No feature-flag gate.
router.use(auth, subscriptionCheck, requireRole(ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN));

router.get('/settings', controller.getSettings);
router.put('/settings', controller.updateSettings);
router.get('/intelligence', controller.getIntelligence);

module.exports = router;
