const router = require('express').Router();
const controller = require('../controllers/project.controller');
const workspace = require('../controllers/projectWorkspace.controller');
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

// Workspace reads. These are static paths, so they MUST sit before '/:id'.
router.get('/templates', workspace.listTemplates);
router.get('/summary', requireRole(...MANAGERS), workspace.projectSummary);
router.get('/workspace', requireRole(...MANAGERS), workspace.listWorkspace);
router.get('/overbooked', requireRole(...MANAGERS), workspace.listOverbooked);

// projects CRUD (manager+ write, all read)
router.get('/', controller.listProjects);
router.post('/', requireRole(...MANAGERS), controller.createProject);
router.get('/:id', controller.getProject);
router.put('/:id', requireRole(...MANAGERS), controller.updateProject);
router.delete('/:id', requireRole(...MANAGERS), controller.deleteProject);

// Per-project workspace
router.get('/:id/workspace', workspace.getWorkspace);
router.get('/:id/items', workspace.listItems);
router.get('/:id/timesheets-detail', requireRole(...MANAGERS), workspace.listProjectTimesheets);
router.get('/:id/team', workspace.getTeam);
router.get('/:id/modules/:module', workspace.listModule);
router.post('/:id/modules/:module', requireRole(...MANAGERS), workspace.createModuleItem);
router.patch('/:id/modules/:module/:itemId', requireRole(...MANAGERS), workspace.updateModuleItem);
router.delete('/:id/modules/:module/:itemId', requireRole(...MANAGERS), workspace.deleteModuleItem);
router.patch('/:id/hold', requireRole(...MANAGERS), workspace.holdProject);
router.patch('/:id/resume', requireRole(...MANAGERS), workspace.resumeProject);
router.patch('/:id/phase', requireRole(...MANAGERS), workspace.advancePhase);
router.post('/:id/timesheets/approve-matching', requireRole(...MANAGERS), workspace.approveMatching);

module.exports = router;
