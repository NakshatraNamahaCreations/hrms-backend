const router = require('express').Router();
const controller = require('../controllers/platform.controller');
const { auth, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { upload } = require('../middleware/upload');
const { ROLES } = require('../constants');

router.use(auth, requireRole(ROLES.SUPER_ADMIN));

// dashboard
router.get('/dashboard', controller.dashboard);

// companies
router.get('/companies', controller.listCompanies);
router.post('/companies', upload.single('logo'), audit('company.create', 'Company'), controller.createCompany);
router.get('/companies/:id', controller.getCompany);
router.put('/companies/:id', upload.single('logo'), controller.updateCompany);
router.delete('/companies/:id', controller.deleteCompany);
router.patch('/companies/:id/suspend', controller.suspendCompany);
router.patch('/companies/:id/activate', controller.activateCompany);
router.get('/companies/:id/usage', controller.companyUsage);
router.get('/companies/:id/features', controller.getCompanyFeatures);
router.put('/companies/:id/features', controller.toggleCompanyFeature);
router.post('/companies/:id/admin', controller.createCompanyAdmin);
router.post('/companies/:id/admins/:userId/reset-password', controller.resetCompanyAdminPassword);

// plans
router.get('/plans', controller.listPlans);
router.post('/plans', controller.createPlan);
router.get('/plans/:id', controller.getPlan);
router.put('/plans/:id', controller.updatePlan);
router.delete('/plans/:id', controller.deletePlan);

// subscriptions
router.get('/subscriptions', controller.subscriptionHistory);
router.post('/subscriptions', controller.assignSubscription);
router.post('/subscriptions/:id/renew', controller.renewSubscription);

// payments
router.get('/payments', controller.listPayments);
router.post('/payments/order', controller.createPaymentOrder);
router.post('/payments/verify', controller.verifyPayment);
router.get('/payments/:id/invoice', controller.paymentInvoice);

module.exports = router;
