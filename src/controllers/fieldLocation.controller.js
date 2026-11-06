const dayjs = require('dayjs');
const FieldLocationLog = require('../models/FieldLocationLog');
const FieldVisit = require('../models/FieldVisit');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { haversineMeters } = require('../utils/geo');

// POST /field/locations/bulk  { points: [{ latitude, longitude, capturedAt, batteryLevel?, accuracy?, speed?, deviceId? }] }
const bulkIngest = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const { points } = req.body;
  if (!Array.isArray(points) || !points.length) throw new ApiError(400, 'points[] is required');

  // validate against an active checked-in visit
  const activeVisit = await FieldVisit.findOne({
    companyId,
    employeeId: req.user.employeeId,
    status: 'checked_in',
    checkOutTime: null,
  })
    .sort({ checkInTime: -1 })
    .lean();
  if (!activeVisit) {
    throw new ApiError(400, 'No active checked-in visit. Location tracking only runs during an active field visit.');
  }

  const docs = [];
  const errors = [];
  points.forEach((p, idx) => {
    if (p.latitude == null || p.longitude == null) {
      errors.push({ index: idx, error: 'latitude and longitude are required' });
      return;
    }
    docs.push({
      companyId,
      employeeId: req.user.employeeId,
      workAssignmentId: activeVisit.workAssignmentId,
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      accuracy: p.accuracy != null ? Number(p.accuracy) : null,
      speed: p.speed != null ? Number(p.speed) : null,
      capturedAt: p.capturedAt ? new Date(p.capturedAt) : new Date(),
      batteryLevel: p.batteryLevel != null ? Number(p.batteryLevel) : null,
      deviceId: p.deviceId || null,
      trackingType: 'interval',
    });
  });

  const inserted = docs.length ? await FieldLocationLog.insertMany(docs) : [];
  return created(res, { inserted: inserted.length, rejected: errors }, 'Location points saved');
});

// GET /field/locations/route?employeeId&date — ordered points for route playback.
// Also accepts ?visitId= (FieldVisit id) which derives employeeId + date.
const getRoute = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  let { employeeId } = req.query;
  let date = req.query.date || dayjs().format('YYYY-MM-DD');
  if (req.query.visitId) {
    const visit = await FieldVisit.findOne({ _id: req.query.visitId, companyId }).select('employeeId date').lean();
    if (!visit) throw new ApiError(404, 'Field visit not found');
    employeeId = visit.employeeId;
    date = visit.date;
  }
  if (!employeeId) throw new ApiError(400, 'employeeId (or visitId) is required');

  const points = await FieldLocationLog.find({
    companyId,
    employeeId,
    capturedAt: { $gte: dayjs(date).startOf('day').toDate(), $lte: dayjs(date).endOf('day').toDate() },
  })
    .sort({ capturedAt: 1 })
    .lean();

  let distanceMeters = 0;
  for (let i = 1; i < points.length; i += 1) {
    distanceMeters += haversineMeters(
      points[i - 1].latitude,
      points[i - 1].longitude,
      points[i].latitude,
      points[i].longitude
    );
  }
  return ok(res, {
    employeeId,
    date,
    pointCount: points.length,
    totalDistanceKm: Math.round((distanceMeters / 1000) * 100) / 100,
    points,
  }, 'Route');
});

// GET /field/locations/live — latest point per currently checked-in field employee
const liveLocations = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const todayStr = dayjs().format('YYYY-MM-DD');

  const activeVisits = await FieldVisit.find({
    companyId,
    date: todayStr,
    status: 'checked_in',
    checkOutTime: null,
  })
    .populate('employeeId', 'employeeCode personal.firstName personal.lastName personal.phone')
    .populate('clientId', 'name address location')
    .populate('workAssignmentId', 'title status priority')
    .lean();

  const live = await Promise.all(
    activeVisits.map(async (visit) => {
      const lastPoint = await FieldLocationLog.findOne({
        companyId,
        employeeId: visit.employeeId._id,
      })
        .sort({ capturedAt: -1 })
        .lean();

      let distanceFromClient = null;
      if (lastPoint && visit.clientId && visit.clientId.location && visit.clientId.location.latitude != null) {
        distanceFromClient = haversineMeters(
          lastPoint.latitude,
          lastPoint.longitude,
          visit.clientId.location.latitude,
          visit.clientId.location.longitude
        );
      }
      return {
        employee: visit.employeeId,
        assignment: visit.workAssignmentId,
        client: visit.clientId,
        visitId: visit._id,
        checkInTime: visit.checkInTime,
        location: lastPoint
          ? { latitude: lastPoint.latitude, longitude: lastPoint.longitude, accuracy: lastPoint.accuracy }
          : visit.checkInLocation,
        distanceFromClient,
        batteryLevel: lastPoint ? lastPoint.batteryLevel : null,
        lastUpdatedAt: lastPoint ? lastPoint.capturedAt : visit.checkInTime,
      };
    })
  );

  return ok(res, live, 'Live field employee locations');
});

module.exports = { bulkIngest, getRoute, liveLocations };
