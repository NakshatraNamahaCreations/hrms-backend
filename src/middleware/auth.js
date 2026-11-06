const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

// Verifies the access token and attaches req.user = { userId, companyId, role, employeeId }
const auth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    throw new ApiError(401, 'Authentication required');
  }
  const token = header.slice(7);
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
  } catch (e) {
    throw new ApiError(401, 'Invalid or expired token');
  }
  const user = await User.findById(decoded.userId);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'Account not found or deactivated');
  }
  req.user = {
    userId: user._id,
    companyId: user.companyId,
    role: user.role,
    employeeId: user.employeeId,
    name: user.name,
    email: user.email,
  };
  next();
});

// Role guard: requireRole('company_admin', 'hr_admin')
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (!roles.includes(req.user.role)) {
    return next(new ApiError(403, 'You do not have permission to perform this action'));
  }
  return next();
};

module.exports = { auth, requireRole };
