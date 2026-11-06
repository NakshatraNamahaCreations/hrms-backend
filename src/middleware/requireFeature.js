const CompanySubscription = require('../models/CompanySubscription');
const CompanyFeature = require('../models/CompanyFeature');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ROLES } = require('../constants');

/**
 * Effective features = latest subscription plan's enabledFeatures
 * merged with per-company overrides in company_features.
 */
const getEffectiveFeatures = async (companyId) => {
  if (!companyId) return [];
  const [sub, overrides] = await Promise.all([
    CompanySubscription.findOne({ companyId }).sort({ createdAt: -1 }).populate('planId').lean(),
    CompanyFeature.find({ companyId }).lean(),
  ]);
  const set = new Set((sub && sub.planId && sub.planId.enabledFeatures) || []);
  for (const o of overrides) {
    if (o.enabled) set.add(o.featureKey);
    else set.delete(o.featureKey);
  }
  return [...set];
};

// Blocks the request when the feature is disabled for the company (super_admin bypasses).
const requireFeature = (featureKey) =>
  asyncHandler(async (req, res, next) => {
    if (req.user.role === ROLES.SUPER_ADMIN) return next();
    const features = await getEffectiveFeatures(req.user.companyId);
    if (!features.includes(featureKey)) {
      throw new ApiError(403, `The '${featureKey}' module is not enabled for your company`);
    }
    return next();
  });

module.exports = { requireFeature, getEffectiveFeatures };
