const router = require('express').Router();
const controller = require('../controllers/report.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { ROLES } = require('../constants');

const REPORT_ROLES = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.PAYROLL_ADMIN, ROLES.MANAGER, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireRole(...REPORT_ROLES));

router.get('/:type', controller.getReport);

module.exports = router;
