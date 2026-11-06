const RecruitmentJob = require('../models/RecruitmentJob');
const Candidate = require('../models/Candidate');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const crudFactory = require('../utils/crudFactory');
const { toPublicUrl } = require('../middleware/upload');
const { CANDIDATE_STATUS } = require('../constants');

const jobs = crudFactory(RecruitmentJob, {
  label: 'Job',
  searchFields: ['title', 'description'],
  filterFields: ['status', 'departmentId', 'branchId', 'employmentType'],
  populate: [
    { path: 'departmentId', select: 'name' },
    { path: 'designationId', select: 'name' },
    { path: 'branchId', select: 'name' },
  ],
  beforeCreate: async (req, data) => {
    if (!data.title) throw new ApiError(400, 'title is required');
    data.postedBy = req.user.userId;
  },
});

const candidates = crudFactory(Candidate, {
  label: 'Candidate',
  searchFields: ['name', 'email', 'phone', 'currentCompany'],
  filterFields: ['jobId', 'status'],
  populate: [{ path: 'jobId', select: 'title status' }],
  beforeCreate: async (req, data) => {
    if (!data.name || !data.email || !data.jobId) throw new ApiError(400, 'name, email and jobId are required');
    const job = await RecruitmentJob.findOne({ _id: data.jobId, companyId: getCompanyId(req), isDeleted: false });
    if (!job) throw new ApiError(404, 'Job not found');
    if (job.status !== 'open') throw new ApiError(400, 'Cannot add candidates to a non-open job');
  },
});

// PATCH /recruitment/candidates/:id/status  { status, note?, interviewDate?, rating? }
// Pipeline: applied → screening → shortlisted → interview → offered → hired; 'rejected' allowed from any non-terminal stage.
const updateCandidateStatus = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { status } = req.body;
  if (!CANDIDATE_STATUS.includes(status)) {
    throw new ApiError(400, `Invalid status. Allowed: ${CANDIDATE_STATUS.join(', ')}`);
  }
  const candidate = await Candidate.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!candidate) throw new ApiError(404, 'Candidate not found');

  const pipeline = ['applied', 'screening', 'shortlisted', 'interview', 'offered', 'hired'];
  if (['hired', 'rejected'].includes(candidate.status)) {
    throw new ApiError(400, `Candidate is already '${candidate.status}'`);
  }
  if (status !== 'rejected') {
    const curIdx = pipeline.indexOf(candidate.status);
    const nextIdx = pipeline.indexOf(status);
    if (nextIdx <= curIdx) {
      throw new ApiError(400, `Cannot move candidate from '${candidate.status}' back to '${status}'`);
    }
  }

  candidate.status = status;
  if (req.body.interviewDate) candidate.interviewDate = new Date(req.body.interviewDate);
  if (req.body.rating != null) candidate.rating = req.body.rating;
  if (req.body.note) candidate.notes.push({ by: req.user.userId, note: req.body.note });
  await candidate.save();
  return ok(res, candidate, `Candidate moved to '${status}'`);
});

// POST /recruitment/candidates/:id/resume (multipart 'file')
const uploadResume = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const candidate = await Candidate.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!candidate) throw new ApiError(404, 'Candidate not found');
  if (!req.file) throw new ApiError(400, 'file is required');
  candidate.resume = toPublicUrl(req.file.path);
  await candidate.save();
  return ok(res, candidate, 'Resume uploaded');
});

// GET /recruitment/jobs/:id/pipeline — candidates grouped by stage
const jobPipeline = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const job = await RecruitmentJob.findOne({ _id: req.params.id, companyId, isDeleted: false }).lean();
  if (!job) throw new ApiError(404, 'Job not found');
  const candidateList = await Candidate.find({ companyId, jobId: job._id, isDeleted: false }).lean();
  const grouped = {};
  for (const s of CANDIDATE_STATUS) grouped[s] = [];
  for (const c of candidateList) grouped[c.status].push(c);
  return ok(res, { job, pipeline: grouped }, 'Job pipeline');
});

module.exports = { jobs, candidates, updateCandidateStatus, uploadResume, jobPipeline };
