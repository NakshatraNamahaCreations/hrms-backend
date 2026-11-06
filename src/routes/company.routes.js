const router = require('express').Router();
const controller = require('../controllers/company.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { ROLES } = require('../constants');

router.use(auth, subscriptionCheck, requireRole(ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN));

router.get('/profile', controller.getProfile);
router.put('/profile', controller.updateProfile);

module.exports = router;
