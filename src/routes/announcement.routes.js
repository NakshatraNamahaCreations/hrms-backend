const router = require('express').Router();
const controller = require('../controllers/announcement.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.ANNOUNCEMENTS));

router.get('/', controller.listForReader); // all roles read (audience-filtered)
router.get('/manage', requireRole(...HR), controller.list); // admin management list
router.post('/', requireRole(...HR), controller.create);
router.get('/:id', controller.get);
router.put('/:id', requireRole(...HR), controller.update);
router.delete('/:id', requireRole(...HR), controller.remove);

module.exports = router;
