const router = require('express').Router();
const controller = require('../controllers/ticket.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const ADMINS = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.TICKETS));

router.post('/', controller.createTicket);
router.get('/', controller.listTickets);
router.get('/:id', controller.getTicket);
router.patch('/:id/status', controller.updateStatus); // role rules enforced in controller
router.patch('/:id/assign', requireRole(...ADMINS), controller.assignTicket);
router.post('/:id/comments', controller.addComment);
router.post('/:id/replies', controller.addComment); // admin panel alias

module.exports = router;
