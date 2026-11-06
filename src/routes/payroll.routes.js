const router = require('express').Router();
const controller = require('../controllers/payroll.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { audit } = require('../middleware/audit');
const { ROLES, FEATURES } = require('../constants');

const PAYROLL_ADMINS = [ROLES.PAYROLL_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.PAYROLL));

router.post('/generate', requireRole(...PAYROLL_ADMINS), controller.generate);
router.post('/run', requireRole(...PAYROLL_ADMINS), controller.generate); // admin panel alias
router.get('/', controller.list); // employees see own finalized payslips; admins see all
router.get('/preview', requireRole(...PAYROLL_ADMINS), controller.preview);
router.get('/payslip', controller.payslipData);
router.get('/payslip/html', controller.payslipHtml);
router.get('/payslips', controller.list); // mobile alias — employees get own finalized payslips
router.get('/payslips/:id', controller.payslipById);
router.get('/form16', controller.form16); // payroll_admin+ any employee; employees self (before '/:id')
router.post('/email-payslips', requireRole(...PAYROLL_ADMINS), controller.emailPayslips);
router.patch('/:id/approve', requireRole(...PAYROLL_ADMINS), audit('payroll.approve', 'Payroll'), controller.approve);
router.patch('/:id/mark-paid', requireRole(...PAYROLL_ADMINS), controller.markPaid);
router.post('/lock', requireRole(...PAYROLL_ADMINS), audit('payroll.lock', 'Payroll'), controller.lock);
router.post('/:id/lock', requireRole(...PAYROLL_ADMINS), controller.lockOne);
router.get('/:id', controller.getOne);

module.exports = router;
