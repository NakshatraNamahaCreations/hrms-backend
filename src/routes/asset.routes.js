const router = require('express').Router();
const { assetCrud, assignAsset, returnAsset, assetHistory } = require('../controllers/asset.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.ASSET_MANAGEMENT), requireRole(...HR, ROLES.MANAGER));

router.get('/', assetCrud.list);
router.post('/', requireRole(...HR), assetCrud.create);
router.get('/:id', assetCrud.get);
router.put('/:id', requireRole(...HR), assetCrud.update);
router.delete('/:id', requireRole(...HR), assetCrud.remove);
router.post('/:id/assign', requireRole(...HR), assignAsset);
router.post('/:id/return', requireRole(...HR), returnAsset);
router.get('/:id/history', assetHistory);

module.exports = router;
