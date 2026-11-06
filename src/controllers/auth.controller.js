const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const dayjs = require('dayjs');
const User = require('../models/User');
const Company = require('../models/Company');
const CompanySubscription = require('../models/CompanySubscription');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');
const { getEffectiveFeatures } = require('../middleware/requireFeature');
const { notify } = require('../services/notification.service');
const { ROLES } = require('../constants');

const signTokens = (user) => {
  const payload = {
    userId: user._id,
    companyId: user.companyId,
    role: user.role,
    employeeId: user.employeeId || undefined,
  };
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET || 'dev-secret', {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret', {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
  return { accessToken, refreshToken };
};

const sanitizeUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  companyId: user.companyId,
  employeeId: user.employeeId,
  isActive: user.isActive,
  preferences: user.preferences || {},
});

// Loads company + subscription, enforcing the 402 rules. Returns { company, subscription }.
const loadCompanyContext = async (companyId) => {
  if (!companyId) return { company: null, subscription: null };
  const company = await Company.findById(companyId).lean();
  if (!company) throw new ApiError(402, 'Company account not found');
  if (company.status === 'suspended') {
    throw new ApiError(402, 'Your company account is suspended. Please contact support.');
  }
  const subscription = await CompanySubscription.findOne({ companyId }).sort({ createdAt: -1 }).populate('planId');
  if (!subscription) throw new ApiError(402, 'No subscription found for your company. Please contact support.');
  let { status } = subscription;
  if (['trial', 'active', 'payment_due'].includes(status) && subscription.endDate && dayjs(subscription.endDate).isBefore(dayjs())) {
    status = 'expired';
    subscription.status = 'expired';
    await subscription.save();
  }
  if (status === 'expired') throw new ApiError(402, 'Your company subscription has expired. Please renew to continue.');
  if (status === 'suspended') throw new ApiError(402, 'Your company subscription is suspended. Please contact support.');
  return { company, subscription };
};

// POST /auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, 'Email and password are required');

  // The `email` field carries an identifier that is EITHER an email OR an employee code.
  const id = String(email || '').trim();
  let user = null;
  if (id.includes('@')) {
    user = await User.findOne({ email: id.toLowerCase() }).select('+password');
  } else {
    const emp = await Employee.findOne({
      employeeCode: new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
      isDeleted: false,
    }).select('_id');
    if (emp) user = await User.findOne({ employeeId: emp._id }).select('+password');
  }
  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, 'Invalid login ID or password');
  }
  if (!user.isActive) throw new ApiError(401, 'Your account is deactivated. Please contact your administrator.');

  let company = null;
  let subscription = null;
  let features = [];
  if (user.role !== ROLES.SUPER_ADMIN) {
    ({ company, subscription } = await loadCompanyContext(user.companyId));
    features = await getEffectiveFeatures(user.companyId);
  }

  let employee = null;
  if (user.employeeId) {
    employee = await Employee.findById(user.employeeId)
      .populate('job.branchId job.departmentId job.designationId job.shiftId')
      .lean();
  }

  user.lastLoginAt = new Date();
  if (req.body.deviceId) user.deviceId = req.body.deviceId;
  if (req.body.fcmToken) user.fcmToken = req.body.fcmToken;
  await user.save();

  const tokens = signTokens(user);
  return ok(res, {
    user: sanitizeUser(user),
    company,
    subscription: subscription
      ? {
          _id: subscription._id,
          status: subscription.status,
          billingCycle: subscription.billingCycle,
          endDate: subscription.endDate,
          plan: subscription.planId ? { _id: subscription.planId._id, name: subscription.planId.name } : null,
        }
      : null,
    employee,
    features,
    tokens,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  }, 'Login successful');
});

// POST /auth/refresh-token
const refreshToken = asyncHandler(async (req, res) => {
  const token = req.body.refreshToken;
  if (!token) throw new ApiError(400, 'refreshToken is required');
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret');
  } catch (e) {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }
  const user = await User.findById(decoded.userId);
  if (!user || !user.isActive) throw new ApiError(401, 'Account not found or deactivated');
  if (user.role !== ROLES.SUPER_ADMIN) await loadCompanyContext(user.companyId);
  const tokens = signTokens(user);
  return ok(res, { tokens, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }, 'Token refreshed');
});

// POST /auth/forgot-password
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new ApiError(400, 'Email is required');
  const user = await User.findOne({ email: String(email).toLowerCase().trim() });
  // Always respond OK to avoid account enumeration
  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.passwordResetExpires = dayjs().add(1, 'hour').toDate();
    await user.save();
    const resetLink = `${process.env.CLIENT_URL || 'http://localhost:5173'}/reset-password?token=${rawToken}`;
    await notify({
      companyId: user.companyId,
      userId: user._id,
      title: 'Password reset requested',
      message: `Use this link to reset your password (valid 1 hour): ${resetLink}`,
      type: 'auth',
      channels: ['email'],
    });
  }
  return ok(res, null, 'If the email exists, a password reset link has been sent');
});

// POST /auth/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) throw new ApiError(400, 'token and password are required');
  if (String(password).length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    passwordResetToken: hashed,
    passwordResetExpires: { $gt: new Date() },
  }).select('+password +passwordResetToken +passwordResetExpires');
  if (!user) throw new ApiError(400, 'Reset token is invalid or has expired');
  user.password = password;
  user.passwordResetToken = null;
  user.passwordResetExpires = null;
  await user.save();
  return ok(res, null, 'Password reset successful. Please login.');
});

// POST /auth/change-password (authenticated)
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) throw new ApiError(400, 'currentPassword and newPassword are required');
  if (String(newPassword).length < 6) throw new ApiError(400, 'New password must be at least 6 characters');
  const user = await User.findById(req.user.userId).select('+password');
  if (!user || !(await user.comparePassword(currentPassword))) {
    throw new ApiError(400, 'Current password is incorrect');
  }
  user.password = newPassword;
  await user.save();
  return ok(res, null, 'Password changed successfully');
});

// GET /auth/me
const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.userId).lean();
  let company = null;
  let features = [];
  if (user.companyId) {
    company = await Company.findById(user.companyId).lean();
    features = await getEffectiveFeatures(user.companyId);
  }
  let employee = null;
  if (user.employeeId) {
    employee = await Employee.findById(user.employeeId)
      .populate('job.branchId job.departmentId job.designationId job.shiftId job.managerId')
      .lean();
  }
  return ok(res, { user: sanitizeUser(user), company, employee, features }, 'Profile');
});

// PATCH /auth/me/preferences  { preferences: { ... } } — persists the whole object
const updatePreferences = asyncHandler(async (req, res) => {
  const { preferences } = req.body;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new ApiError(400, 'preferences (object) is required');
  }
  const user = await User.findByIdAndUpdate(
    req.user.userId,
    { $set: { preferences } },
    { new: true }
  ).lean();
  if (!user) throw new ApiError(404, 'User not found');
  return ok(res, { user: sanitizeUser(user) }, 'Preferences updated');
});

module.exports = { login, refreshToken, forgotPassword, resetPassword, changePassword, me, updatePreferences };
