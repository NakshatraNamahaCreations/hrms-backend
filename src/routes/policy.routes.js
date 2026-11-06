const router = require('express').Router();
const controller = require('../controllers/policy.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { upload } = require('../middleware/upload');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.HR_POLICIES));

router.get('/', controller.listPolicies);
router.post('/', requireRole(...HR), upload.single('file'), controller.createPolicy);
router.put('/:id', requireRole(...HR), upload.single('file'), controller.updatePolicy);
router.delete('/:id', requireRole(...HR), controller.deletePolicy);
router.post('/:id/acknowledge', controller.acknowledgePolicy);
router.get('/:id/acks', requireRole(...HR), controller.listAcks);

module.exports = router;
