const router = require('express').Router();
const controller = require('../controllers/auth.controller');
const { auth } = require('../middleware/auth');

router.post('/login', controller.login);
router.post('/refresh-token', controller.refreshToken);
router.post('/forgot-password', controller.forgotPassword);
router.post('/reset-password', controller.resetPassword);
router.post('/change-password', auth, controller.changePassword);
router.get('/me', auth, controller.me);
router.patch('/me/preferences', auth, controller.updatePreferences);

module.exports = router;
