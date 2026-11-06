const router = require('express').Router();
const { cycles, submitReview, finalizeReview, listReviews, getReview } = require('../controllers/performance.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.PERFORMANCE));

// cycles
router.get('/cycles', cycles.list);
router.post('/cycles', requireRole(...HR), cycles.create);
router.get('/cycles/:id', cycles.get);
router.put('/cycles/:id', requireRole(...HR), cycles.update);
router.delete('/cycles/:id', requireRole(...HR), cycles.remove);

// reviews
router.get('/reviews', listReviews);
router.post('/reviews', submitReview);
router.get('/reviews/:id', getReview);
router.patch('/reviews/:id/finalize', requireRole(...HR), finalizeReview);

module.exports = router;
