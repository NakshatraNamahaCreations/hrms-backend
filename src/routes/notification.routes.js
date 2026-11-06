const router = require('express').Router();
const controller = require('../controllers/notification.controller');
const { auth, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { ROLES } = require('../constants');

router.use(auth);

router.get('/', controller.listNotifications);
router.post(
  '/send',
  requireRole(ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN),
  audit('notification.send', 'Notification'),
  controller.sendNotification
);
router.post('/register-device', controller.registerDevice);
router.patch('/read-all', controller.markAllRead);
router.patch('/:id/read', controller.markRead);

module.exports = router;
