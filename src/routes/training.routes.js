const router = require('express').Router();
const controller = require('../controllers/training.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.TRAINING));

router.get('/courses', controller.listCourses);
router.post('/courses', requireRole(...HR), controller.createCourse);
router.get('/courses/:id/progress', requireRole(...HR), controller.courseProgress);
router.put('/courses/:id', requireRole(...HR), controller.updateCourse);
router.delete('/courses/:id', requireRole(...HR), controller.deleteCourse);
router.post('/assign', requireRole(...HR), controller.assignCourse);
router.get('/my', controller.myAssignments);
router.patch('/assignments/:id/complete', controller.completeAssignment);

module.exports = router;
