const router = require('express').Router();
const { deviceCrud, ingestPunches, listLogs, syncDevice } = require('../controllers/biometric.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const ADMINS = [ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

// punch webhook — authenticated by deviceKey (no JWT)
router.post('/punch', ingestPunches);

router.use(auth, subscriptionCheck, requireFeature(FEATURES.BIOMETRIC));

router.get('/devices', requireRole(...ADMINS, ROLES.HR_ADMIN), deviceCrud.list);
router.post('/devices', requireRole(...ADMINS), deviceCrud.create);
router.get('/devices/:id', requireRole(...ADMINS, ROLES.HR_ADMIN), deviceCrud.get);
router.put('/devices/:id', requireRole(...ADMINS), deviceCrud.update);
router.delete('/devices/:id', requireRole(...ADMINS), deviceCrud.remove);
router.post('/devices/:id/sync', requireRole(...ADMINS, ROLES.HR_ADMIN), syncDevice);
router.get('/logs', requireRole(...ADMINS, ROLES.HR_ADMIN), listLogs);

module.exports = router;
