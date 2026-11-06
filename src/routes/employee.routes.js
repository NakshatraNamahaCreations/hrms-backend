const router = require('express').Router();
const controller = require('../controllers/employee.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { audit } = require('../middleware/audit');
const { upload } = require('../middleware/upload');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN];
const HR_PLUS_MANAGER = [...HR, ROLES.MANAGER, ROLES.PAYROLL_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.EMPLOYEE_MANAGEMENT));

router.get('/', requireRole(...HR_PLUS_MANAGER), controller.listEmployees);
router.post('/', requireRole(...HR), audit('employee.create', 'Employee'), controller.createEmployee);
// static sub-routes MUST be registered before '/:id'
router.get('/import-template', requireRole(...HR), controller.importTemplate);
router.post('/bulk-import', requireRole(...HR), upload.single('file'), controller.bulkImport);
router.get('/probation-due', requireRole(...HR), controller.probationDue);
router.get('/org-chart', controller.orgChart); // all roles — read-only company hierarchy
router.get('/:id', controller.getEmployee); // self-or-admin enforced in controller
router.put('/:id', requireRole(...HR), controller.updateEmployee);
router.delete('/:id', requireRole(...HR), controller.deleteEmployee);
router.patch('/:id/onboarding-status', requireRole(...HR), controller.updateOnboardingStatus);
router.patch('/:id/confirm', requireRole(...HR), controller.confirmEmployee);
router.post('/:id/documents', requireRole(...HR), upload.single('file'), controller.uploadDocument);

module.exports = router;
