const router = require('express').Router();
const { jobs, candidates, updateCandidateStatus, uploadResume, jobPipeline } = require('../controllers/recruitment.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { upload } = require('../middleware/upload');
const { ROLES, FEATURES } = require('../constants');

const HR = [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN];

router.use(auth, subscriptionCheck, requireFeature(FEATURES.RECRUITMENT), requireRole(...HR, ROLES.MANAGER));

// jobs
router.get('/jobs', jobs.list);
router.post('/jobs', requireRole(...HR), jobs.create);
router.get('/jobs/:id', jobs.get);
router.get('/jobs/:id/pipeline', jobPipeline);
router.put('/jobs/:id', requireRole(...HR), jobs.update);
router.delete('/jobs/:id', requireRole(...HR), jobs.remove);

// candidates
router.get('/candidates', candidates.list);
router.post('/candidates', requireRole(...HR), candidates.create);
router.get('/candidates/:id', candidates.get);
router.put('/candidates/:id', requireRole(...HR), candidates.update);
router.delete('/candidates/:id', requireRole(...HR), candidates.remove);
router.patch('/candidates/:id/status', updateCandidateStatus);
router.post('/candidates/:id/resume', requireRole(...HR), upload.single('file'), uploadResume);

module.exports = router;
