const router = require('express').Router();
const clientCrud = require('../controllers/client.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const CLIENT_ROLES = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.MANAGER, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.CLIENT_WORK_ASSIGNMENT));

router.get('/', requireRole(...CLIENT_ROLES, ROLES.FIELD_EMPLOYEE), clientCrud.list);
router.get('/:id', requireRole(...CLIENT_ROLES, ROLES.FIELD_EMPLOYEE), clientCrud.get);
router.post('/', requireRole(...CLIENT_ROLES), clientCrud.create);
router.put('/:id', requireRole(...CLIENT_ROLES), clientCrud.update);
router.delete('/:id', requireRole(...CLIENT_ROLES), clientCrud.remove);

module.exports = router;
