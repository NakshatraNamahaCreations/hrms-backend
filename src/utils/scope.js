const ApiError = require('./ApiError');
const { ROLES } = require('../constants');

/**
 * Resolves the tenant companyId for the request.
 * Regular users are ALWAYS scoped to their own company.
 * super_admin may pass ?companyId= (platform routes) — otherwise it's required.
 */
const getCompanyId = (req, { required = true } = {}) => {
  if (req.user.role === ROLES.SUPER_ADMIN) {
    const companyId = req.query.companyId || req.body.companyId || req.params.companyId;
    if (!companyId && required) {
      throw new ApiError(400, 'companyId is required for super_admin on this route');
    }
    return companyId || null;
  }
  return req.user.companyId;
};

const isAdminRole = (role) =>
  [ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN].includes(role);

const isManagerial = (role) =>
  [ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.MANAGER].includes(role);

module.exports = { getCompanyId, isAdminRole, isManagerial };
