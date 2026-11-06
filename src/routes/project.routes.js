const router = require('express').Router();
const controller = require('../controllers/project.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const MANAGERS = [ROLES.MANAGER, ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.PROJECTS));

// timesheets (registered before '/:id')
router.post('/timesheets', controller.submitTimesheet);
router.get('/timesheets', controller.listTimesheets);
router.get('/timesheets/summary', requireRole(...MANAGERS), controller.timesheetSummary);
router.patch('/timesheets/:id/approve', requireRole(...MANAGERS), controller.approveTimesheet);
router.patch('/timesheets/:id/reject', requireRole(...MANAGERS), controller.rejectTimesheet);

// projects CRUD (manager+ write, all read)
router.get('/', controller.listProjects);
router.post('/', requireRole(...MANAGERS), controller.createProject);
router.get('/:id', controller.getProject);
router.put('/:id', requireRole(...MANAGERS), controller.updateProject);
router.delete('/:id', requireRole(...MANAGERS), controller.deleteProject);

module.exports = router;
