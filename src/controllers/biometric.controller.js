const crypto = require('crypto');
const dayjs = require('dayjs');
const BiometricDevice = require('../models/BiometricDevice');
const BiometricLog = require('../models/BiometricLog');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const crudFactory = require('../utils/crudFactory');

const deviceCrud = crudFactory(BiometricDevice, {
  label: 'Biometric device',
  searchFields: ['name', 'deviceKey', 'location'],
  beforeCreate: async (req, data) => {
    if (!data.deviceKey) data.deviceKey = `dev_${crypto.randomBytes(12).toString('hex')}`;
  },
});

// POST /biometric/punch — device webhook (deviceKey auth, NOT JWT)
// body: { deviceKey, punches: [{ biometricUserId, timestamp, direction? }] }
const ingestPunches = asyncHandler(async (req, res) => {
  const { deviceKey, punches } = req.body;
  if (!deviceKey) throw new ApiError(401, 'deviceKey is required');
  if (!Array.isArray(punches) || !punches.length) throw new ApiError(400, 'punches[] is required');

  const device = await BiometricDevice.findOne({ deviceKey, isActive: true, isDeleted: false });
  if (!device) throw new ApiError(401, 'Unknown or inactive device');
  device.lastSeenAt = new Date();
  await device.save();

  const companyId = device.companyId;
  const results = [];
  const touched = new Map(); // `${employeeId}|${date}` for attendance upsert

  for (const punch of punches) {
    if (!punch.biometricUserId || !punch.timestamp) {
      results.push({ biometricUserId: punch.biometricUserId, ok: false, error: 'biometricUserId and timestamp are required' });
      continue;
    }
    const ts = new Date(punch.timestamp);
    if (Number.isNaN(ts.getTime())) {
      results.push({ biometricUserId: punch.biometricUserId, ok: false, error: 'Invalid timestamp' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const employee = await Employee.findOne({
      companyId,
      biometricUserId: String(punch.biometricUserId),
      isDeleted: false,
    }).select('_id').lean();

    // eslint-disable-next-line no-await-in-loop
    const log = await BiometricLog.create({
      companyId,
      deviceId: device._id,
      biometricUserId: String(punch.biometricUserId),
      employeeId: employee ? employee._id : null,
      timestamp: ts,
      direction: ['in', 'out'].includes(punch.direction) ? punch.direction : 'unknown',
      processed: Boolean(employee),
      raw: punch,
    });

    if (employee) {
      touched.set(`${employee._id}|${dayjs(ts).format('YYYY-MM-DD')}`, { employeeId: employee._id, date: dayjs(ts).format('YYYY-MM-DD') });
      results.push({ biometricUserId: punch.biometricUserId, ok: true, logId: log._id });
    } else {
      results.push({ biometricUserId: punch.biometricUserId, ok: false, error: 'No employee matched', logId: log._id });
    }
  }

  // upsert attendance: first punch = check-in, last punch = check-out
  for (const { employeeId, date } of touched.values()) {
    // eslint-disable-next-line no-await-in-loop
    const dayLogs = await BiometricLog.find({
      companyId,
      employeeId,
      timestamp: { $gte: dayjs(date).startOf('day').toDate(), $lte: dayjs(date).endOf('day').toDate() },
    })
      .sort({ timestamp: 1 })
      .lean();
    if (!dayLogs.length) continue;

    const first = dayLogs[0].timestamp;
    const last = dayLogs[dayLogs.length - 1].timestamp;
    const update = {
      checkIn: { time: first, source: 'biometric' },
      attendanceSource: 'biometric',
      status: 'present',
    };
    if (dayLogs.length > 1) {
      update.checkOut = { time: last, source: 'biometric' };
      const workMinutes = Math.max(Math.round((new Date(last) - new Date(first)) / 60000), 0);
      update.workMinutes = workMinutes;
      update.totalHours = Math.round((workMinutes / 60) * 100) / 100;
    }
    // eslint-disable-next-line no-await-in-loop
    const existing = await Attendance.findOne({ companyId, employeeId, date }).select('isLocked').lean();
    if (existing && existing.isLocked) continue;
    // eslint-disable-next-line no-await-in-loop
    await Attendance.findOneAndUpdate(
      { companyId, employeeId, date },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  return created(res, { received: punches.length, results }, 'Punches processed');
});

// GET /biometric/logs
const listLogs = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId };
  if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  if (req.query.deviceId) filter.deviceId = req.query.deviceId;
  if (req.query.date) {
    filter.timestamp = {
      $gte: dayjs(req.query.date).startOf('day').toDate(),
      $lte: dayjs(req.query.date).endOf('day').toDate(),
    };
  }
  const { items, pagination } = await paginate(req.query, BiometricLog, filter, {
    populate: [
      { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName' },
      { path: 'deviceId', select: 'name' },
    ],
    sort: { timestamp: -1 },
  });
  return ok(res, items, 'Biometric logs', pagination);
});

// POST /biometric/devices/:id/sync — manual sync trigger. Real device pulls happen through
// the vendor middleware pushing to /biometric/punch; this records the sync request time.
const syncDevice = asyncHandler(async (req, res) => {
  const device = await BiometricDevice.findOne({ _id: req.params.id, companyId: getCompanyId(req), isDeleted: false });
  if (!device) throw new ApiError(404, 'Biometric device not found');
  device.lastSyncedAt = new Date();
  await device.save();
  return ok(res, device, 'Sync requested — punches will arrive via the device webhook');
});

module.exports = { deviceCrud, ingestPunches, listLogs, syncDevice };
