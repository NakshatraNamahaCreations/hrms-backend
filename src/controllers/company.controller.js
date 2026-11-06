const Company = require('../models/Company');
const CompanySubscription = require('../models/CompanySubscription');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { getEffectiveFeatures } = require('../middleware/requireFeature');

// GET /company/profile
const getProfile = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const company = await Company.findById(companyId).lean();
  if (!company) throw new ApiError(404, 'Company not found');
  const [subscription, features] = await Promise.all([
    CompanySubscription.findOne({ companyId }).sort({ createdAt: -1 }).populate('planId').lean(),
    getEffectiveFeatures(companyId),
  ]);
  return ok(res, { ...company, subscription, features }, 'Company profile');
});

// PUT /company/profile — updates basic info + settings (attendance rules, geo-fencing,
// trackingIntervalMinutes, office timings, week-offs, leave policy, payroll rules)
const updateProfile = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const company = await Company.findById(companyId);
  if (!company) throw new ApiError(404, 'Company not found');

  const updatable = ['name', 'logo', 'address', 'gst', 'pan', 'cin', 'contactPerson', 'email', 'phone'];
  for (const key of updatable) {
    if (req.body[key] !== undefined) company[key] = req.body[key];
  }

  if (req.body.settings && typeof req.body.settings === 'object') {
    const s = req.body.settings;
    const current = company.toObject().settings || {};
    company.settings = {
      ...current,
      attendance: { ...current.attendance, ...(s.attendance || {}) },
      geoFencing: { ...current.geoFencing, ...(s.geoFencing || {}) },
      trackingIntervalMinutes:
        s.trackingIntervalMinutes !== undefined ? s.trackingIntervalMinutes : current.trackingIntervalMinutes,
      officeTimings: { ...current.officeTimings, ...(s.officeTimings || {}) },
      weekOffDays: s.weekOffDays !== undefined ? s.weekOffDays : current.weekOffDays,
      leavePolicy: { ...current.leavePolicy, ...(s.leavePolicy || {}) },
      leave: { ...current.leave, ...(s.leave || {}) },
      payroll: { ...current.payroll, ...(s.payroll || {}) },
      employeeCode: { ...current.employeeCode, ...(s.employeeCode || {}) },
    };
    company.markModified('settings');
  }

  await company.save();
  return ok(res, company, 'Company settings updated');
});

module.exports = { getProfile, updateProfile };
