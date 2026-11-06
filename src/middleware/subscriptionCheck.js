const dayjs = require('dayjs');
const Company = require('../models/Company');
const CompanySubscription = require('../models/CompanySubscription');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ROLES } = require('../constants');

// Returns 402 when the company is suspended or its subscription expired/suspended.
// super_admin is always allowed through.
const subscriptionCheck = asyncHandler(async (req, res, next) => {
  if (!req.user || req.user.role === ROLES.SUPER_ADMIN) return next();

  const company = await Company.findById(req.user.companyId).select('status').lean();
  if (!company) throw new ApiError(402, 'Company account not found');
  if (company.status === 'suspended') {
    throw new ApiError(402, 'Your company account is suspended. Please contact support.');
  }

  const sub = await CompanySubscription.findOne({ companyId: req.user.companyId })
    .sort({ createdAt: -1 });
  if (!sub) throw new ApiError(402, 'No subscription found for your company. Please contact support.');

  let { status } = sub;
  if (['trial', 'active', 'payment_due'].includes(status) && sub.endDate && dayjs(sub.endDate).isBefore(dayjs())) {
    status = 'expired';
    sub.status = 'expired';
    await sub.save();
  }
  if (status === 'expired') {
    throw new ApiError(402, 'Your company subscription has expired. Please renew to continue.');
  }
  if (status === 'suspended') {
    throw new ApiError(402, 'Your company subscription is suspended. Please contact support.');
  }
  req.subscription = sub;
  return next();
});

module.exports = subscriptionCheck;
