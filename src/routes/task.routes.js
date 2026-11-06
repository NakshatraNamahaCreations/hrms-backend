const router = require('express').Router();
const controller = require('../controllers/task.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const MANAGERS = [ROLES.MANAGER, ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.TASKS));

router.get('/', controller.listTasks);
router.post('/', requireRole(...MANAGERS), controller.createTask);
router.get('/:id', controller.getTask);
router.put('/:id', requireRole(...MANAGERS), controller.updateTask);
router.patch('/:id/status', controller.updateStatus);
router.post('/:id/comments', controller.addComment);
router.delete('/:id', requireRole(...MANAGERS), controller.deleteTask);

module.exports = router;
