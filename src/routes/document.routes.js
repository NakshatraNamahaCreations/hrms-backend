const router = require('express').Router();
const controller = require('../controllers/document.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { upload } = require('../middleware/upload');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.DOCUMENTS));

router.post('/', upload.single('file'), controller.uploadDocument);
router.get('/', controller.listDocuments);
router.post('/generate', requireRole(...HR), controller.generateLetter);
router.post('/generate-letter', requireRole(...HR), controller.generateLetter); // admin panel alias
router.patch('/:id/verify', requireRole(...HR), controller.verifyDocument);
router.patch('/:id/reject', requireRole(...HR), controller.rejectDocument);
router.delete('/:id', requireRole(...HR), controller.deleteDocument);
router.get('/:id/render', controller.renderDocument);

module.exports = router;
