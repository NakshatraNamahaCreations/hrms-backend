const PerformanceCycle = require('../models/PerformanceCycle');
const PerformanceReview = require('../models/PerformanceReview');
const Employee = require('../models/Employee');
const FieldWorkAssignment = require('../models/FieldWorkAssignment');
const FieldVisit = require('../models/FieldVisit');
const FieldLocationLog = require('../models/FieldLocationLog');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isManagerial } = require('../utils/scope');
const crudFactory = require('../utils/crudFactory');
const { haversineMeters } = require('../utils/geo');
const dayjs = require('dayjs');
const { ROLES } = require('../constants');

const cycles = crudFactory(PerformanceCycle, {
  label: 'Review cycle',
  searchFields: ['name'],
  filterFields: ['status'],
  beforeCreate: async (req, data) => {
    if (!data.name || !data.startDate || !data.endDate) {
      throw new ApiError(400, 'name, startDate and endDate are required');
    }
  },
});

// Field performance metrics within the cycle window.
const computeFieldMetrics = async (companyId, employeeId, cycle) => {
  const from = dayjs(cycle.startDate).format('YYYY-MM-DD');
  const to = dayjs(cycle.endDate).format('YYYY-MM-DD');

  const assignments = await FieldWorkAssignment.find({
    companyId,
    employeeId,
    date: { $gte: from, $lte: to },
    isDeleted: false,
  }).lean();
  const visits = await FieldVisit.find({ companyId, employeeId, date: { $gte: from, $lte: to } }).lean();

  const completed = assignments.filter((a) => ['completed', 'checked_out'].includes(a.status));

  // on-time: checked in no later than 15 minutes after the assignment's planned startTime
  let onTime = 0;
  let withSchedule = 0;
  const visitByAssignment = new Map(visits.map((v) => [String(v.workAssignmentId), v]));
  for (const a of assignments) {
    const v = visitByAssignment.get(String(a._id));
    if (!v || !v.checkInTime || !a.startTime) continue;
    withSchedule += 1;
    const planned = dayjs(`${a.date} ${a.startTime}`);
    if (dayjs(v.checkInTime).diff(planned, 'minute') <= 15) onTime += 1;
  }

  const logs = await FieldLocationLog.find({
    companyId,
    employeeId,
    capturedAt: { $gte: dayjs(cycle.startDate).toDate(), $lte: dayjs(cycle.endDate).endOf('day').toDate() },
  })
    .sort({ capturedAt: 1 })
    .select('latitude longitude capturedAt')
    .lean();
  let meters = 0;
  for (let i = 1; i < logs.length; i += 1) {
    if (dayjs(logs[i].capturedAt).isSame(dayjs(logs[i - 1].capturedAt), 'day')) {
      meters += haversineMeters(logs[i - 1].latitude, logs[i - 1].longitude, logs[i].latitude, logs[i].longitude);
    }
  }

  return {
    totalAssignments: assignments.length,
    completedVisits: completed.length,
    completionRate: assignments.length ? Math.round((completed.length / assignments.length) * 100) : 0,
    onTimePercent: withSchedule ? Math.round((onTime / withSchedule) * 100) : null,
    totalDistanceKm: Math.round((meters / 1000) * 100) / 100,
    totalWorkMinutes: visits.reduce((s, v) => s + (v.totalWorkMinutes || 0), 0),
  };
};

// POST /performance/reviews  { cycleId, employeeId?, type: self|manager|hr, rating, ratings?, comments? }
const submitReview = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { cycleId, type, rating } = req.body;
  if (!['self', 'manager', 'hr'].includes(type)) throw new ApiError(400, "type must be 'self', 'manager' or 'hr'");
  if (!rating || rating < 1 || rating > 5) throw new ApiError(400, 'rating (1-5) is required');

  const cycle = await PerformanceCycle.findOne({ _id: cycleId, companyId, isDeleted: false });
  if (!cycle) throw new ApiError(404, 'Review cycle not found');
  if (cycle.status === 'closed') throw new ApiError(400, 'This review cycle is closed');

  let employeeId = req.body.employeeId;
  if (type === 'self') {
    if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
    employeeId = req.user.employeeId;
  } else {
    if (!isManagerial(req.user.role)) throw new ApiError(403, 'Only managers/HR can submit this review type');
    if (!employeeId) throw new ApiError(400, 'employeeId is required');
    if (type === 'hr' && ![ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN].includes(req.user.role)) {
      throw new ApiError(403, 'Only HR/company admins can submit HR reviews');
    }
  }

  const employee = await Employee.findOne({ _id: employeeId, companyId, isDeleted: false });
  if (!employee) throw new ApiError(404, 'Employee not found');

  const section = {
    submittedBy: req.user.userId,
    rating,
    ratings: req.body.ratings || {},
    comments: req.body.comments || null,
    submittedAt: new Date(),
  };
  const fieldName = `${type}Review`;
  const review = await PerformanceReview.findOneAndUpdate(
    { companyId, cycleId, employeeId },
    { $set: { [fieldName]: section, status: 'in_progress' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return created(res, review, `${type} review submitted`);
});

// PATCH /performance/reviews/:id/finalize  { finalRating }
const finalizeReview = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { finalRating } = req.body;
  if (!finalRating || finalRating < 1 || finalRating > 5) throw new ApiError(400, 'finalRating (1-5) is required');
  const review = await PerformanceReview.findOne({ _id: req.params.id, companyId });
  if (!review) throw new ApiError(404, 'Review not found');
  review.finalRating = finalRating;
  review.finalizedBy = req.user.userId;
  review.finalizedAt = new Date();
  review.status = 'finalized';
  await review.save();
  return ok(res, review, 'Review finalized');
});

// GET /performance/reviews?cycleId&employeeId
const listReviews = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
  } else if (req.query.employeeId) {
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.cycleId) filter.cycleId = req.query.cycleId;
  if (req.query.status) filter.status = req.query.status;
  const { items, pagination } = await paginate(req.query, PerformanceReview, filter, {
    populate: [
      { path: 'cycleId', select: 'name startDate endDate status' },
      { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName job.employeeType' },
    ],
  });
  return ok(res, items, 'Performance reviews', pagination);
});

// GET /performance/reviews/:id — includes computed field metrics for field employees
const getReview = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.employeeId = req.user.employeeId;
  }
  const review = await PerformanceReview.findOne(filter)
    .populate('cycleId')
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName job.employeeType')
    .lean();
  if (!review) throw new ApiError(404, 'Review not found');

  let fieldMetrics = null;
  if (review.employeeId && review.employeeId.job && review.employeeId.job.employeeType === 'field_employee' && review.cycleId) {
    fieldMetrics = await computeFieldMetrics(companyId, review.employeeId._id, review.cycleId);
  }
  return ok(res, { ...review, fieldMetrics }, 'Review detail');
});

module.exports = { cycles, submitReview, finalizeReview, listReviews, getReview };
