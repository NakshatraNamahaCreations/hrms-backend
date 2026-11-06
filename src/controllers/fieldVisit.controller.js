const dayjs = require('dayjs');
const FieldVisit = require('../models/FieldVisit');
const FieldWorkAssignment = require('../models/FieldWorkAssignment');
const FieldLocationLog = require('../models/FieldLocationLog');
const Company = require('../models/Company');
const Client = require('../models/Client');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { haversineMeters } = require('../utils/geo');
const { toPublicUrl } = require('../middleware/upload');
const { notify } = require('../services/notification.service');
const fieldAttendanceService = require('../services/fieldAttendance.service');
const { ROLES } = require('../constants');

const OUTSIDE_MESSAGE =
  'You are outside the assigned client location. Please reach the client location or submit a reason for approval.';

const POPULATE = [
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName userId' },
  { path: 'clientId', select: 'name address location' },
  { path: 'workAssignmentId', select: 'title status date statusHistory assignedBy' },
];

// Routes may address a visit by :id or, from the mobile app, by workAssignmentId only —
// in that case resolve the employee's active checked-in visit for that assignment.
const resolveVisitId = async (req) => {
  if (req.params.id) return;
  const workAssignmentId = req.body.workAssignmentId;
  if (!workAssignmentId) throw new ApiError(400, 'workAssignmentId is required when no visit id is given');
  const visit = await FieldVisit.findOne({
    companyId: req.user.companyId,
    employeeId: req.user.employeeId,
    workAssignmentId,
    status: 'checked_in',
  }).select('_id');
  if (!visit) throw new ApiError(404, 'No active checked-in visit found for this assignment');
  req.params.id = String(visit._id);
};

// POST /field/visits/check-in  { workAssignmentId, latitude, longitude, accuracy?, reason? }
const checkIn = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const { workAssignmentId, latitude, longitude } = req.body;
  if (!workAssignmentId || latitude == null || longitude == null) {
    throw new ApiError(400, 'workAssignmentId, latitude and longitude are required');
  }

  // 1. Load assignment + company settings
  const assignment = await FieldWorkAssignment.findOne({
    _id: workAssignmentId,
    companyId,
    employeeId: req.user.employeeId,
    isDeleted: false,
  });
  if (!assignment) throw new ApiError(404, 'Work assignment not found');
  if (['completed', 'checked_out', 'cancelled', 'rejected'].includes(assignment.status)) {
    throw new ApiError(400, `Assignment is '${assignment.status}' and cannot be checked into`);
  }
  const existingVisit = await FieldVisit.findOne({ companyId, workAssignmentId, status: 'checked_in' });
  if (existingVisit) throw new ApiError(409, 'You are already checked in for this assignment');

  const company = await Company.findById(companyId).select('settings.geoFencing').lean();
  const geo = (company && company.settings && company.settings.geoFencing) || {};
  const client = await Client.findById(assignment.clientId).select('geoFenceRadiusMeters').lean();
  const radius = (client && client.geoFenceRadiusMeters) || geo.radiusMeters || 200;

  // 2. Haversine distance from submitted GPS to assignment.clientLocation
  // (clients without coordinates have no geo-fence — check-in allowed anywhere)
  const hasClientLocation =
    assignment.clientLocation && assignment.clientLocation.latitude != null;
  const distanceMeters = hasClientLocation
    ? haversineMeters(
        Number(latitude),
        Number(longitude),
        assignment.clientLocation.latitude,
        assignment.clientLocation.longitude
      )
    : null;

  // 3 & 4. Geo-fencing decision
  const inside = !geo.enabled || !hasClientLocation || distanceMeters <= radius;
  let approvalStatus = 'none';
  if (!inside) {
    if (geo.allowOutsideWithReason && req.body.reason) {
      approvalStatus = 'pending';
    } else {
      throw new ApiError(403, OUTSIDE_MESSAGE);
    }
  }

  const now = new Date();
  const checkInFiles = req.files || {};
  const visit = await FieldVisit.create({
    companyId,
    employeeId: req.user.employeeId,
    workAssignmentId: assignment._id,
    clientId: assignment.clientId,
    // multi-day jobs: each day's check-in is its own visit, dated TODAY
    date: dayjs().format('YYYY-MM-DD'),
    selfie: checkInFiles.selfie && checkInFiles.selfie[0] ? toPublicUrl(checkInFiles.selfie[0].path) : null,
    checkInTime: now,
    checkInLocation: {
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: req.body.accuracy || null,
      address: req.body.address || null,
    },
    distanceMeters,
    status: 'checked_in',
    approvalStatus,
    outsideReason: approvalStatus === 'pending' ? req.body.reason : null,
  });

  assignment.status = 'checked_in';
  assignment.statusHistory.push({ status: 'checked_in', by: req.user.userId, note: approvalStatus === 'pending' ? `Outside geo-fence (${distanceMeters}m): ${req.body.reason}` : null });
  await assignment.save();

  await FieldLocationLog.create({
    companyId,
    employeeId: req.user.employeeId,
    workAssignmentId: assignment._id,
    latitude: Number(latitude),
    longitude: Number(longitude),
    accuracy: req.body.accuracy || null,
    capturedAt: now,
    batteryLevel: req.body.batteryLevel || null,
    deviceId: req.body.deviceId || null,
    trackingType: 'checkin',
  });

  // attendance is captured immediately at check-in (Present, in-time = now);
  // checkout later fills the out-time and total hours
  const attendance = await fieldAttendanceService.upsertDayAttendance(
    companyId,
    req.user.employeeId,
    visit.date
  );

  if (approvalStatus === 'pending') {
    await notify({
      companyId,
      userId: assignment.assignedBy,
      title: 'Outside geo-fence check-in needs approval',
      message: `${req.user.name} checked in ${distanceMeters}m away from the client for "${assignment.title}". Reason: ${req.body.reason}`,
      type: 'field_visit_approval',
      meta: { visitId: visit._id },
    });
  }

  return created(res, { visit, attendance, distanceMeters, radiusMeters: radius, withinGeoFence: inside, approvalStatus },
    approvalStatus === 'pending'
      ? 'Checked in outside geo-fence — pending manager approval'
      : 'Checked in successfully');
});

// POST /field/visits/:id/proof — multipart fields: photos[], selfie, signature; body: remarks
const uploadProof = asyncHandler(async (req, res) => {
  await resolveVisitId(req);
  const companyId = req.user.companyId;
  const visit = await FieldVisit.findOne({ _id: req.params.id, companyId, employeeId: req.user.employeeId });
  if (!visit) throw new ApiError(404, 'Field visit not found');

  const files = req.files || {};
  if (files.photos) visit.photos.push(...files.photos.map((f) => toPublicUrl(f.path)));
  if (files.selfie && files.selfie[0]) visit.selfie = toPublicUrl(files.selfie[0].path);
  if (files.signature && files.signature[0]) visit.clientSignature = toPublicUrl(files.signature[0].path);
  if (req.body.remarks) visit.remarks = req.body.remarks;
  if (!files.photos && !files.selfie && !files.signature) {
    throw new ApiError(400, 'Attach at least one of: photos, selfie, signature');
  }
  visit.proofStatus = 'submitted';
  await visit.save();
  return ok(res, visit, 'Proof uploaded');
});

// POST /field/visits/:id/checkout  { latitude, longitude, remarks? }
const checkout = asyncHandler(async (req, res) => {
  await resolveVisitId(req);
  const companyId = req.user.companyId;
  const visit = await FieldVisit.findOne({ _id: req.params.id, companyId, employeeId: req.user.employeeId });
  if (!visit) throw new ApiError(404, 'Field visit not found');
  if (visit.checkOutTime) throw new ApiError(409, 'Already checked out from this visit');

  const now = new Date();
  visit.checkOutTime = now;
  if (req.body.latitude != null) {
    visit.checkOutLocation = {
      latitude: Number(req.body.latitude),
      longitude: Number(req.body.longitude),
      accuracy: req.body.accuracy || null,
      address: req.body.address || null,
    };
  }
  if (req.body.remarks) visit.remarks = req.body.remarks;
  visit.totalWorkMinutes = Math.max(Math.round((now - new Date(visit.checkInTime)) / 60000), 0);
  visit.status = 'checked_out';
  await visit.save();

  // Multi-day jobs: a daily checkout does NOT finish the job — the assignment
  // goes back to 'in_progress' so the employee can check in again tomorrow.
  // The job is finished only by an explicit 'completed' status change.
  const assignment = await FieldWorkAssignment.findById(visit.workAssignmentId);
  if (assignment && !['completed', 'checked_out', 'cancelled'].includes(assignment.status)) {
    assignment.status = 'in_progress';
    assignment.statusHistory.push({ status: 'in_progress', by: req.user.userId, note: 'Day checkout — job continues' });
    await assignment.save();
  }

  if (req.body.latitude != null) {
    await FieldLocationLog.create({
      companyId,
      employeeId: req.user.employeeId,
      workAssignmentId: visit.workAssignmentId,
      latitude: Number(req.body.latitude),
      longitude: Number(req.body.longitude),
      capturedAt: now,
      batteryLevel: req.body.batteryLevel || null,
      deviceId: req.body.deviceId || null,
      trackingType: 'checkout',
    });
  }

  // derive day attendance from field visits
  const attendance = await fieldAttendanceService.upsertDayAttendance(companyId, req.user.employeeId, visit.date);

  return ok(res, { visit, attendance }, 'Checked out from visit');
});

// PATCH /field/visits/:id/approval  { action: 'approve' | 'reject', note? } — manager approves outside check-in
const actOnApproval = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) throw new ApiError(400, "action must be 'approve' or 'reject'");
  const visit = await FieldVisit.findOne({ _id: req.params.id, companyId }).populate('employeeId', 'userId');
  if (!visit) throw new ApiError(404, 'Field visit not found');
  if (visit.approvalStatus !== 'pending') throw new ApiError(400, 'This visit has no pending geo-fence approval');

  visit.approvalStatus = action === 'approve' ? 'approved' : 'rejected';
  visit.approvalActionBy = req.user.userId;
  visit.approvalActionAt = new Date();
  await visit.save();

  if (visit.employeeId && visit.employeeId.userId) {
    await notify({
      companyId,
      userId: visit.employeeId.userId,
      title: `Outside check-in ${visit.approvalStatus}`,
      message: `Your outside-location check-in on ${visit.date} was ${visit.approvalStatus}.${req.body.note ? ` Note: ${req.body.note}` : ''}`,
      type: 'field_visit_approval',
    });
  }
  return ok(res, visit, `Check-in ${visit.approvalStatus}`);
});

// PATCH /field/visits/:id/proof-verify  { action: 'verify' | 'reject', reason? }
const verifyProof = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { action } = req.body;
  if (!['verify', 'reject'].includes(action)) throw new ApiError(400, "action must be 'verify' or 'reject'");
  const visit = await FieldVisit.findOne({ _id: req.params.id, companyId }).populate('employeeId', 'userId');
  if (!visit) throw new ApiError(404, 'Field visit not found');
  if (visit.proofStatus !== 'submitted') throw new ApiError(400, `Proof is '${visit.proofStatus || 'not submitted'}' and cannot be ${action === 'verify' ? 'verified' : 'rejected'}`);

  visit.proofStatus = action === 'verify' ? 'verified' : 'rejected';
  visit.proofActionBy = req.user.userId;
  visit.proofActionAt = new Date();
  if (action === 'reject') visit.proofRejectReason = req.body.reason || null;
  await visit.save();

  if (visit.employeeId && visit.employeeId.userId) {
    await notify({
      companyId,
      userId: visit.employeeId.userId,
      title: `Visit proof ${visit.proofStatus}`,
      message: `Your visit proof for ${visit.date} was ${visit.proofStatus}.${req.body.reason ? ` Reason: ${req.body.reason}` : ''}`,
      type: 'field_visit_proof',
    });
  }
  return ok(res, visit, `Proof ${visit.proofStatus}`);
});

// GET /field/visits
const listVisits = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if (req.user.role === ROLES.FIELD_EMPLOYEE) filter.employeeId = req.user.employeeId;
  else if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  if (req.query.date) filter.date = req.query.date;
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.approvalStatus) filter.approvalStatus = req.query.approvalStatus;
  if (req.query.proofStatus) filter.proofStatus = req.query.proofStatus;
  const { items, pagination } = await paginate(req.query, FieldVisit, filter, {
    searchFields: ['date', 'status', 'remarks'],
    sortable: ['date', 'checkInTime', 'checkOutTime', 'status', 'totalWorkMinutes', 'createdAt'],
    populate: POPULATE,
    sort: { checkInTime: -1 },
  });
  return ok(res, items, 'Field visits', pagination);
});

// GET /field/visits/summary?date&month&employeeId — field summary
// - employeeId omitted + company_admin/hr_admin/manager → company-wide aggregate
// - month=YYYY-MM aggregates that month instead of a single date
// - field employees always default to self
const summary = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  let employeeId = req.query.employeeId;
  if (req.user.role === ROLES.FIELD_EMPLOYEE) employeeId = req.user.employeeId;
  const companyWide = !employeeId;
  if (companyWide
    && ![ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.MANAGER, ROLES.SUPER_ADMIN].includes(req.user.role)) {
    throw new ApiError(400, 'employeeId is required');
  }

  if (req.query.month) {
    if (!/^\d{4}-\d{2}$/.test(req.query.month)) throw new ApiError(400, 'month must be YYYY-MM');
    const start = dayjs(`${req.query.month}-01`);
    const data = await fieldAttendanceService.rangeSummary(companyId, {
      employeeId: employeeId || null,
      from: start.format('YYYY-MM-DD'),
      to: start.endOf('month').format('YYYY-MM-DD'),
    });
    return ok(res, { month: req.query.month, ...data }, 'Monthly field summary');
  }

  const date = req.query.date || dayjs().format('YYYY-MM-DD');
  if (companyWide) {
    const data = await fieldAttendanceService.rangeSummary(companyId, { employeeId: null, from: date, to: date });
    return ok(res, { date, ...data }, 'Daily field summary');
  }
  const data = await fieldAttendanceService.dailySummary(companyId, employeeId, date);
  return ok(res, data, 'Daily field summary');
});

// GET /field/visits/:id — detail with timeline
const getVisit = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId };
  if (req.user.role === ROLES.FIELD_EMPLOYEE) filter.employeeId = req.user.employeeId;
  const visit = await FieldVisit.findOne(filter).populate(POPULATE).lean();
  if (!visit) throw new ApiError(404, 'Field visit not found');

  const timeline = [];
  const assignment = visit.workAssignmentId;
  if (assignment && Array.isArray(assignment.statusHistory)) {
    for (const h of assignment.statusHistory) {
      timeline.push({ at: h.at, event: `assignment_${h.status}`, note: h.note || null });
    }
  }
  if (visit.checkInTime) timeline.push({ at: visit.checkInTime, event: 'visit_check_in', note: visit.outsideReason });
  if (visit.proofActionAt) timeline.push({ at: visit.proofActionAt, event: `proof_${visit.proofStatus}`, note: visit.proofRejectReason });
  if (visit.checkOutTime) timeline.push({ at: visit.checkOutTime, event: 'visit_check_out', note: visit.remarks });
  timeline.sort((a, b) => new Date(a.at) - new Date(b.at));

  const locationCount = await FieldLocationLog.countDocuments({ companyId, workAssignmentId: assignment ? assignment._id : null });
  return ok(res, { ...visit, timeline, locationPoints: locationCount }, 'Field visit detail');
});

module.exports = { checkIn, uploadProof, checkout, actOnApproval, verifyProof, listVisits, summary, getVisit };
