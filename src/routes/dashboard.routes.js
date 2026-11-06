const router = require('express').Router();
const controller = require('../controllers/dashboard.controller');
const { auth } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');

router.use(auth, subscriptionCheck);

router.get('/', controller.getDashboard);

module.exports = router;
