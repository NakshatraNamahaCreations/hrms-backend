const router = require('express').Router();
const controller = require('../controllers/loan.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { audit } = require('../middleware/audit');
const { ROLES, FEATURES } = require('../constants');

const ADMINS = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.PAYROLL_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.LOANS));

router.get('/outstanding', requireRole(...ADMINS), controller.outstanding);
router.get('/', controller.listLoans); // admins all, employees own — scoped in controller
router.post('/', audit('loan.request', 'Loan'), controller.requestLoan);
router.get('/:id', controller.getLoan);
router.patch('/:id/approve', requireRole(...ADMINS), controller.approveLoan);
router.patch('/:id/reject', requireRole(...ADMINS), controller.rejectLoan);
router.patch('/:id/disburse', requireRole(...ADMINS), controller.disburseLoan);
router.post('/:id/payments', requireRole(...ADMINS), audit('loan.payment', 'Loan'), controller.recordPayment);
router.patch('/:id/close', requireRole(...ADMINS), controller.closeLoan);

module.exports = router;
