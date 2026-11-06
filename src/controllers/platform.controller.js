const dayjs = require('dayjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const CompanySubscription = require('../models/CompanySubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const CompanyFeature = require('../models/CompanyFeature');
const Payment = require('../models/Payment');
const Employee = require('../models/Employee');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getEffectiveFeatures } = require('../middleware/requireFeature');
const { logAudit } = require('../middleware/audit');
const razorpayService = require('../services/razorpay.service');
const { notify } = require('../services/notification.service');
const { FEATURE_KEYS, ROLES } = require('../constants');

// Latest subscription per company (returns Map<companyIdString, sub>)
const latestSubscriptions = async (filter = {}) => {
  const subs = await CompanySubscription.find(filter).sort({ createdAt: 1 }).populate('planId', 'name employeeLimit').lean();
  const map = new Map();
  for (const s of subs) map.set(String(s.companyId), s); // later entries overwrite => latest
  return map;
};

// Readable temporary password (no ambiguous chars like 0/O, 1/l/I).
const generateTempPassword = (len = 10) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += chars[bytes[i] % chars.length];
  return out;
};

// Auto-generate a unique company code from the name (uppercase alphanumerics).
// Tries BASE, then BASE2..BASE99, then BASE+random — guarantees uniqueness.
const generateUniqueCompanyCode = async (seed) => {
  const base = String(seed || 'CO').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'CO';
  const candidates = [base];
  for (let i = 2; i <= 99; i += 1) candidates.push(`${base}${i}`);
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await Company.findOne({ code: c }).select('_id').lean();
    if (!exists) return c;
  }
  return `${base}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
};

const effectiveSubStatus = (sub) => {
  if (!sub) return 'expired';
  if (['trial', 'active', 'payment_due'].includes(sub.status) && sub.endDate && dayjs(sub.endDate).isBefore(dayjs())) {
    return 'expired';
  }
  return sub.status;
};

// ===================== DASHBOARD =====================

// GET /platform/dashboard
const dashboard = asyncHandler(async (req, res) => {
  const [companies, subMap, totalEmployees, fieldEmployees, recentCompanies] = await Promise.all([
    Company.find({ isDeleted: false }).select('name status createdAt').lean(),
    latestSubscriptions(),
    Employee.countDocuments({ isDeleted: false, status: 'active' }),
    Employee.countDocuments({ isDeleted: false, status: 'active', 'job.employeeType': 'field_employee' }),
    Company.find({ isDeleted: false }).sort({ createdAt: -1 }).limit(5).select('name code email status createdAt').lean(),
  ]);

  const stats = { total: companies.length, active: 0, trial: 0, expired: 0, suspended: 0, payment_due: 0 };
  const planWise = {};
  for (const c of companies) {
    const sub = subMap.get(String(c._id));
    const status = c.status === 'suspended' ? 'suspended' : effectiveSubStatus(sub);
    if (stats[status] !== undefined) stats[status] += 1;
    const planName = (sub && sub.planId && sub.planId.name) || 'No Plan';
    planWise[planName] = (planWise[planName] || 0) + 1;
  }

  const monthStart = dayjs().startOf('month').toDate();
  const yearStart = dayjs().startOf('year').toDate();
  const [monthlyRevenueAgg, yearlyRevenueAgg, totalRevenueAgg] = await Promise.all([
    Payment.aggregate([{ $match: { status: 'paid', paidAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $match: { status: 'paid', paidAt: { $gte: yearStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);

  // 12-month revenue trend
  const trendStart = dayjs().subtract(11, 'month').startOf('month').toDate();
  const monthlyTrend = await Payment.aggregate([
    { $match: { status: 'paid', paidAt: { $gte: trendStart } } },
    { $group: { _id: { y: { $year: '$paidAt' }, m: { $month: '$paidAt' } }, total: { $sum: '$amount' } } },
    { $sort: { '_id.y': 1, '_id.m': 1 } },
  ]);

  const pendingAgg = await Payment.aggregate([
    { $match: { status: 'created' } },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
  ]);

  return ok(res, {
    companies: stats,
    employees: { total: totalEmployees, fieldEmployees, officeEmployees: totalEmployees - fieldEmployees },
    revenue: {
      monthly: (monthlyRevenueAgg[0] && monthlyRevenueAgg[0].total) || 0,
      yearly: (yearlyRevenueAgg[0] && yearlyRevenueAgg[0].total) || 0,
      allTime: (totalRevenueAgg[0] && totalRevenueAgg[0].total) || 0,
      trend: monthlyTrend.map((t) => ({ month: `${t._id.y}-${String(t._id.m).padStart(2, '0')}`, total: t.total })),
    },
    pendingPayments: {
      count: (pendingAgg[0] && pendingAgg[0].count) || 0,
      amount: (pendingAgg[0] && pendingAgg[0].amount) || 0,
    },
    planWise,
    recentCompanies,
  }, 'Platform dashboard');
});

// ===================== COMPANIES =====================

// GET /platform/companies
// ?status= filters the tenant ACCOUNT status (Company.status enum);
// ?subscriptionStatus= filters by the computed subscription status the list
// displays (latest subscription per company + end-date expiry — effectiveSubStatus).
const listCompanies = asyncHandler(async (req, res) => {
  const filter = { isDeleted: false };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.subscriptionStatus) {
    const wanted = String(req.query.subscriptionStatus);
    const [allCompanies, allSubs] = await Promise.all([
      Company.find({ isDeleted: false }).select('_id').lean(),
      latestSubscriptions(),
    ]);
    filter._id = {
      $in: allCompanies
        .filter((c) => effectiveSubStatus(allSubs.get(String(c._id))) === wanted)
        .map((c) => c._id),
    };
  }
  const { items, pagination } = await paginate(req.query, Company, filter, {
    searchFields: ['name', 'code', 'email'],
  });
  const subMap = await latestSubscriptions({ companyId: { $in: items.map((c) => c._id) } });
  const counts = await Employee.aggregate([
    { $match: { companyId: { $in: items.map((c) => c._id) }, isDeleted: false } },
    { $group: { _id: '$companyId', total: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.total]));
  const data = items.map((c) => {
    const sub = subMap.get(String(c._id));
    return {
      ...c,
      employeeCount: countMap.get(String(c._id)) || 0,
      subscription: sub
        ? {
            status: effectiveSubStatus(sub),
            plan: sub.planId,
            endDate: sub.endDate,
            billingCycle: sub.billingCycle,
            employeeLimit: sub.employeeLimit != null ? sub.employeeLimit : (sub.planId ? sub.planId.employeeLimit : null),
          }
        : null,
    };
  });
  return ok(res, data, 'Companies', pagination);
});

// POST /platform/companies
// Multipart submissions JSON-stringify object fields — restore them.
const parseBodyObjects = (body, keys) => {
  for (const key of keys) {
    if (typeof body[key] === 'string' && body[key].trim().startsWith('{')) {
      try {
        body[key] = JSON.parse(body[key]);
      } catch (e) {
        /* leave as-is */
      }
    }
  }
  // tolerate a plain-string contact person from older clients
  if (typeof body.contactPerson === 'string' && body.contactPerson.trim()) {
    body.contactPerson = { name: body.contactPerson.trim() };
  }
  return body;
};

const createCompany = asyncHandler(async (req, res) => {
  parseBodyObjects(req.body, ['address', 'contactPerson', 'subscription', 'admin']);
  const { name, email } = req.body;
  let { code } = req.body;
  if (!name || !email) throw new ApiError(400, 'name and email are required');

  // Company code is auto-generated when omitted, and de-duplicated when supplied,
  // so creating a company never fails on a blank or colliding code.
  if (!code || !String(code).trim()) {
    code = await generateUniqueCompanyCode(name);
  } else {
    code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const taken = await Company.findOne({ code }).select('_id').lean();
    if (taken) code = await generateUniqueCompanyCode(code);
  }
  req.body.code = code;

  const sub = req.body.subscription || {};
  const admin = req.body.admin || null;
  if (admin && admin.email) {
    const exists = await User.findOne({ email: String(admin.email).toLowerCase().trim() });
    if (exists) throw new ApiError(409, `A user with email '${admin.email}' already exists`);
    if (!admin.password || String(admin.password).length < 6) {
      throw new ApiError(400, 'Admin password must be at least 6 characters');
    }
  }

  const companyData = { ...req.body, status: req.body.status || 'active' };
  delete companyData.subscription;
  delete companyData.admin;
  if (req.file) companyData.logo = require('../middleware/upload').toPublicUrl(req.file.path);
  const company = await Company.create(companyData);

  // optional immediate plan assignment (form sends it nested under `subscription`)
  const planId = sub.planId || req.body.planId;
  if (planId) {
    const plan = await SubscriptionPlan.findById(planId);
    if (!plan) throw new ApiError(404, 'Plan not found');
    const billingCycle = sub.billingCycle || req.body.billingCycle || 'trial';
    const startDate = sub.startDate ? new Date(sub.startDate) : new Date();
    const endDate = sub.endDate
      ? new Date(sub.endDate)
      : billingCycle === 'yearly'
        ? dayjs(startDate).add(1, 'year').toDate()
        : billingCycle === 'monthly'
          ? dayjs(startDate).add(1, 'month').toDate()
          : dayjs(startDate).add(plan.trialDays || 14, 'day').toDate();
    await CompanySubscription.create({
      companyId: company._id,
      planId: plan._id,
      startDate,
      endDate,
      billingCycle,
      status: billingCycle === 'trial' ? 'trial' : 'active',
      employeeLimit: Number(sub.employeeLimit) || plan.employeeLimit,
      fieldEmployeeLimit: Number(sub.fieldEmployeeLimit) || plan.fieldEmployeeLimit,
      amount: billingCycle === 'yearly' ? plan.yearlyPrice : billingCycle === 'monthly' ? plan.monthlyPrice : 0,
      assignedBy: req.user.userId,
    });
  }

  // optional company admin login (form step 4)
  let adminUser = null;
  if (admin && admin.email) {
    adminUser = await User.create({
      companyId: company._id,
      name: admin.name || 'Company Admin',
      email: admin.email,
      password: admin.password,
      role: ROLES.COMPANY_ADMIN,
      isActive: true,
    });
  }

  res.locals.auditEntityId = company._id;
  return created(
    res,
    { company, admin: adminUser ? { _id: adminUser._id, email: adminUser.email } : null },
    'Company created'
  );
});

// GET /platform/companies/:id
const getCompany = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id).lean();
  if (!company || company.isDeleted) throw new ApiError(404, 'Company not found');
  const [subscription, features, employeeCount, fieldCount, admins] = await Promise.all([
    CompanySubscription.findOne({ companyId: company._id }).sort({ createdAt: -1 }).populate('planId').lean(),
    getEffectiveFeatures(company._id),
    Employee.countDocuments({ companyId: company._id, isDeleted: false }),
    Employee.countDocuments({ companyId: company._id, isDeleted: false, 'job.employeeType': 'field_employee' }),
    User.find({ companyId: company._id, role: ROLES.COMPANY_ADMIN }).select('name email isActive role lastLoginAt').lean(),
  ]);
  return ok(res, { ...company, subscription, features, employeeCount, fieldCount, admins }, 'Company detail');
});

// PUT /platform/companies/:id
const updateCompany = asyncHandler(async (req, res) => {
  parseBodyObjects(req.body, ['address', 'contactPerson', 'subscription', 'admin']);
  const company = await Company.findById(req.params.id);
  if (!company || company.isDeleted) throw new ApiError(404, 'Company not found');
  const data = { ...req.body };
  delete data._id;
  delete data.status; // use suspend/activate endpoints
  delete data.subscription; // use subscription endpoints
  delete data.admin;
  if (req.file) data.logo = require('../middleware/upload').toPublicUrl(req.file.path);
  Object.assign(company, data);
  await company.save();
  return ok(res, company, 'Company updated');
});

// PATCH /platform/companies/:id/suspend
const suspendCompany = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) throw new ApiError(404, 'Company not found');
  company.status = 'suspended';
  await company.save();
  logAudit(req, { action: 'company.suspend', entityType: 'Company', entityId: company._id, meta: { reason: req.body.reason } });
  return ok(res, company, 'Company suspended');
});

// PATCH /platform/companies/:id/activate
const activateCompany = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) throw new ApiError(404, 'Company not found');
  company.status = 'active';
  await company.save();
  logAudit(req, { action: 'company.activate', entityType: 'Company', entityId: company._id });
  return ok(res, company, 'Company activated');
});

// GET /platform/companies/:id/features
const getCompanyFeatures = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id).select('name').lean();
  if (!company) throw new ApiError(404, 'Company not found');
  const [effective, overrides, sub] = await Promise.all([
    getEffectiveFeatures(req.params.id),
    CompanyFeature.find({ companyId: req.params.id }).lean(),
    CompanySubscription.findOne({ companyId: req.params.id }).sort({ createdAt: -1 }).populate('planId', 'name enabledFeatures').lean(),
  ]);
  return ok(res, {
    allFeatures: FEATURE_KEYS,
    planFeatures: (sub && sub.planId && sub.planId.enabledFeatures) || [],
    overrides,
    effective,
  }, 'Company features');
});

// PUT /platform/companies/:id/features  { featureKey, enabled }
const toggleCompanyFeature = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) throw new ApiError(404, 'Company not found');

  // Accept either a single toggle { featureKey, enabled } or a full map { features: { key: bool } }
  let toggles;
  if (req.body.features && typeof req.body.features === 'object') {
    toggles = Object.entries(req.body.features).filter(
      ([key, enabled]) => FEATURE_KEYS.includes(key) && typeof enabled === 'boolean'
    );
    if (!toggles.length) throw new ApiError(400, 'features must map valid feature keys to booleans');
  } else {
    const { featureKey, enabled } = req.body;
    if (!FEATURE_KEYS.includes(featureKey)) throw new ApiError(400, `Invalid featureKey '${featureKey}'`);
    if (typeof enabled !== 'boolean') throw new ApiError(400, 'enabled must be boolean');
    toggles = [[featureKey, enabled]];
  }

  for (const [featureKey, enabled] of toggles) {
    // eslint-disable-next-line no-await-in-loop
    await CompanyFeature.findOneAndUpdate(
      { companyId: req.params.id, featureKey },
      { $set: { enabled, updatedBy: req.user.userId } },
      { upsert: true, new: true }
    );
  }
  logAudit(req, { action: 'company.feature_toggle', entityType: 'Company', entityId: req.params.id, meta: { toggles } });
  const effective = await getEffectiveFeatures(req.params.id);
  return ok(res, { effective }, 'Company features updated');
});

// POST /platform/companies/:id/admin  { name, email, password }
const createCompanyAdmin = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) throw new ApiError(400, 'name, email and password are required');
  const company = await Company.findById(req.params.id);
  if (!company) throw new ApiError(404, 'Company not found');
  const exists = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (exists) throw new ApiError(409, 'A user with this email already exists');
  const user = await User.create({
    companyId: company._id,
    name,
    email,
    password,
    role: ROLES.COMPANY_ADMIN,
  });
  await notify({
    companyId: company._id,
    userId: user._id,
    title: `Welcome to ${company.name}`,
    message: `Your company admin account has been created. Login with ${email}.`,
    type: 'account',
    channels: ['email'],
  });
  return created(res, { _id: user._id, name: user.name, email: user.email, role: user.role }, 'Company admin created');
});

// POST /platform/companies/:id/admins/:userId/reset-password  { password? }
// Passwords are bcrypt-hashed and unreadable, so a forgotten password can't be
// "looked up". Instead the platform owner resets it to a NEW password that is
// returned once here so it can be shared with the company. Leave `password`
// empty to auto-generate a readable temporary one.
const resetCompanyAdminPassword = asyncHandler(async (req, res) => {
  const { id, userId } = req.params;
  const company = await Company.findById(id);
  if (!company || company.isDeleted) throw new ApiError(404, 'Company not found');

  const user = await User.findOne({ _id: userId, companyId: company._id });
  if (!user) throw new ApiError(404, 'Admin user not found for this company');

  let newPassword = req.body.password ? String(req.body.password).trim() : '';
  if (newPassword) {
    if (newPassword.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
  } else {
    newPassword = generateTempPassword();
  }

  user.password = newPassword; // pre-save hook re-hashes it
  user.isActive = true; // re-enable a locked-out admin so they can log in
  await user.save();

  logAudit(req, {
    action: 'company.admin_password_reset',
    entityType: 'User',
    entityId: user._id,
    meta: { companyId: company._id, email: user.email },
  });

  // Best-effort heads-up to the admin (never blocks the response).
  notify({
    companyId: company._id,
    userId: user._id,
    title: 'Your login password was reset',
    message: `Your ${company.name} admin password was reset by the platform team. Login ID: ${user.email}.`,
    type: 'account',
    channels: ['email'],
  }).catch(() => {});

  return ok(
    res,
    { _id: user._id, name: user.name, email: user.email, password: newPassword },
    'Admin password reset'
  );
});

// DELETE /platform/companies/:id  (soft)
const deleteCompany = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) throw new ApiError(404, 'Company not found');
  company.isDeleted = true;
  company.status = 'inactive';
  await company.save();
  await User.updateMany({ companyId: company._id }, { $set: { isActive: false } });
  logAudit(req, { action: 'company.delete', entityType: 'Company', entityId: company._id });
  return ok(res, null, 'Company deleted');
});

// ===================== PLANS =====================

const listPlans = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(req.query, SubscriptionPlan, {}, { searchFields: ['name'] });
  return ok(res, items, 'Plans', pagination);
});

const createPlan = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.create(req.body);
  return created(res, plan, 'Plan created');
});

const getPlan = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.findById(req.params.id);
  if (!plan) throw new ApiError(404, 'Plan not found');
  return ok(res, plan, 'Plan detail');
});

const updatePlan = asyncHandler(async (req, res) => {
  // Whitelist updatable fields and drop any stale/unknown feature keys, so a plan
  // that was seeded with a feature key no longer in the enum can still be edited
  // (runValidators would otherwise reject the whole update → "nothing changes").
  const ALLOWED = ['name', 'description', 'monthlyPrice', 'yearlyPrice', 'employeeLimit', 'fieldEmployeeLimit', 'trialDays', 'status', 'enabledFeatures'];
  const update = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  if (Array.isArray(update.enabledFeatures)) {
    update.enabledFeatures = update.enabledFeatures.filter((f) => FEATURE_KEYS.includes(f));
  }
  const plan = await SubscriptionPlan.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
  if (!plan) throw new ApiError(404, 'Plan not found');
  return ok(res, plan, 'Plan updated');
});

const deletePlan = asyncHandler(async (req, res) => {
  const inUse = await CompanySubscription.exists({ planId: req.params.id, status: { $in: ['trial', 'active', 'payment_due'] } });
  if (inUse) throw new ApiError(400, 'Plan is in use by active subscriptions; deactivate it instead');
  const plan = await SubscriptionPlan.findByIdAndDelete(req.params.id);
  if (!plan) throw new ApiError(404, 'Plan not found');
  return ok(res, null, 'Plan deleted');
});

// ===================== SUBSCRIPTIONS =====================

const computeEndDate = (startDate, billingCycle, plan) => {
  if (billingCycle === 'yearly') return dayjs(startDate).add(1, 'year').toDate();
  if (billingCycle === 'monthly') return dayjs(startDate).add(1, 'month').toDate();
  return dayjs(startDate).add((plan && plan.trialDays) || 14, 'day').toDate();
};

// POST /platform/subscriptions  { companyId, planId, billingCycle, startDate?, status? }
const assignSubscription = asyncHandler(async (req, res) => {
  const { companyId, planId, billingCycle = 'monthly' } = req.body;
  if (!companyId || !planId) throw new ApiError(400, 'companyId and planId are required');
  const [company, plan] = await Promise.all([Company.findById(companyId), SubscriptionPlan.findById(planId)]);
  if (!company) throw new ApiError(404, 'Company not found');
  if (!plan) throw new ApiError(404, 'Plan not found');

  const startDate = req.body.startDate ? new Date(req.body.startDate) : new Date();
  const endDate = req.body.endDate ? new Date(req.body.endDate) : computeEndDate(startDate, billingCycle, plan);
  const sub = await CompanySubscription.create({
    companyId,
    planId,
    startDate,
    endDate,
    billingCycle,
    status: req.body.status || (billingCycle === 'trial' ? 'trial' : 'active'),
    employeeLimit: req.body.employeeLimit || plan.employeeLimit,
    fieldEmployeeLimit: req.body.fieldEmployeeLimit || plan.fieldEmployeeLimit,
    amount: billingCycle === 'yearly' ? plan.yearlyPrice : billingCycle === 'monthly' ? plan.monthlyPrice : 0,
    assignedBy: req.user.userId,
  });
  logAudit(req, { action: 'subscription.assign', entityType: 'CompanySubscription', entityId: sub._id, meta: { companyId, planId, billingCycle } });
  return created(res, sub, 'Subscription assigned');
});

// POST /platform/subscriptions/:id/renew  { billingCycle?, planId?, endDate? }
const renewSubscription = asyncHandler(async (req, res) => {
  const sub = await CompanySubscription.findById(req.params.id).populate('planId');
  if (!sub) throw new ApiError(404, 'Subscription not found');
  const planChanged = req.body.planId && String(req.body.planId) !== String(sub.planId._id);
  const plan = planChanged ? await SubscriptionPlan.findById(req.body.planId) : sub.planId;
  if (!plan) throw new ApiError(404, 'Plan not found');
  const billingCycle = req.body.billingCycle || (sub.billingCycle === 'trial' ? 'monthly' : sub.billingCycle);
  const base = dayjs(sub.endDate).isAfter(dayjs()) ? sub.endDate : new Date();
  const startDate = new Date(base);
  const endDate = req.body.endDate ? new Date(req.body.endDate) : computeEndDate(startDate, billingCycle, plan);
  const renewed = await CompanySubscription.create({
    companyId: sub.companyId,
    planId: plan._id,
    startDate,
    endDate,
    billingCycle,
    status: 'active',
    employeeLimit: planChanged ? plan.employeeLimit : sub.employeeLimit,
    fieldEmployeeLimit: planChanged ? plan.fieldEmployeeLimit : sub.fieldEmployeeLimit,
    amount: billingCycle === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice,
    assignedBy: req.user.userId,
  });
  logAudit(req, { action: 'subscription.renew', entityType: 'CompanySubscription', entityId: renewed._id, meta: { previous: sub._id } });
  return created(res, renewed, 'Subscription renewed');
});

// GET /platform/subscriptions?companyId=
const subscriptionHistory = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.companyId) filter.companyId = req.query.companyId;
  if (req.query.status) filter.status = req.query.status;
  const { items, pagination } = await paginate(req.query, CompanySubscription, filter, {
    searchFields: ['status', 'billingCycle'],
    sortable: ['createdAt', 'startDate', 'endDate', 'status', 'amount', 'billingCycle'],
    populate: [{ path: 'planId', select: 'name monthlyPrice yearlyPrice' }, { path: 'companyId', select: 'name code' }],
  });
  return ok(res, items, 'Subscription history', pagination);
});

// ===================== PAYMENTS =====================

// POST /platform/payments/order  { companyId, planId, billingCycle }
const createPaymentOrder = asyncHandler(async (req, res) => {
  const { companyId, planId, billingCycle = 'monthly' } = req.body;
  if (!companyId || !planId) throw new ApiError(400, 'companyId and planId are required');
  const [company, plan] = await Promise.all([Company.findById(companyId), SubscriptionPlan.findById(planId)]);
  if (!company) throw new ApiError(404, 'Company not found');
  if (!plan) throw new ApiError(404, 'Plan not found');
  const amount = billingCycle === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice;

  const order = await razorpayService.createOrder({
    amount,
    receipt: `rcpt_${companyId}_${Date.now()}`,
    notes: { companyId: String(companyId), planId: String(planId), billingCycle },
  });

  const payment = await Payment.create({
    companyId,
    planId,
    amount,
    billingCycle,
    razorpayOrderId: order.id,
    status: 'created',
    mode: razorpayService.isMockMode() ? 'mock' : 'live',
    notes: { receipt: order.receipt },
  });
  return created(res, { order, payment }, razorpayService.isMockMode() ? 'Mock order created (no Razorpay keys configured)' : 'Razorpay order created');
});

// POST /platform/payments/verify  { orderId, paymentId, signature }
const verifyPayment = asyncHandler(async (req, res) => {
  const { orderId, paymentId, signature } = req.body;
  if (!orderId) throw new ApiError(400, 'orderId is required');
  const payment = await Payment.findOne({ razorpayOrderId: orderId });
  if (!payment) throw new ApiError(404, 'Payment record not found for this order');
  if (payment.status === 'paid') return ok(res, payment, 'Payment already verified');

  const valid = razorpayService.verifySignature({ orderId, paymentId, signature });
  if (!valid) {
    payment.status = 'failed';
    await payment.save();
    throw new ApiError(400, 'Payment signature verification failed');
  }

  payment.status = 'paid';
  payment.razorpayPaymentId = paymentId || `pay_mock_${Date.now()}`;
  payment.razorpaySignature = signature || null;
  payment.paidAt = new Date();
  payment.invoiceNumber = `INV-${dayjs().format('YYYYMM')}-${String(await Payment.countDocuments({ status: 'paid' }) + 1).padStart(5, '0')}`;

  // activate / extend subscription for the paid plan
  const plan = await SubscriptionPlan.findById(payment.planId);
  if (plan) {
    const startDate = new Date();
    const endDate = computeEndDate(startDate, payment.billingCycle, plan);
    const sub = await CompanySubscription.create({
      companyId: payment.companyId,
      planId: plan._id,
      startDate,
      endDate,
      billingCycle: payment.billingCycle,
      status: 'active',
      employeeLimit: plan.employeeLimit,
      fieldEmployeeLimit: plan.fieldEmployeeLimit,
      amount: payment.amount,
      assignedBy: req.user.userId,
    });
    payment.subscriptionId = sub._id;
  }
  await payment.save();
  logAudit(req, { action: 'payment.verify', entityType: 'Payment', entityId: payment._id, meta: { orderId, amount: payment.amount } });
  return ok(res, payment, 'Payment verified and subscription activated');
});

// GET /platform/payments
const listPayments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.companyId) filter.companyId = req.query.companyId;
  if (req.query.status) filter.status = req.query.status;
  const { items, pagination } = await paginate(req.query, Payment, filter, {
    searchFields: ['status', 'invoiceNumber', 'method', 'razorpayOrderId'],
    sortable: ['createdAt', 'amount', 'status', 'paidAt', 'billingCycle'],
    populate: [{ path: 'companyId', select: 'name code' }, { path: 'planId', select: 'name' }],
  });
  return ok(res, items, 'Payments', pagination);
});

// GET /platform/companies/:id/usage — live usage vs plan limits
const companyUsage = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const company = await Company.findById(companyId).lean();
  if (!company) throw new ApiError(404, 'Company not found');

  const Branch = require('../models/Branch');
  const FieldVisit = require('../models/FieldVisit');
  const FieldWorkAssignment = require('../models/FieldWorkAssignment');
  const EmployeeDocument = require('../models/EmployeeDocument');
  const [totalEmployees, fieldEmployees, branches, users, sub, visitsThisMonth, activeAssignments, storageAgg] = await Promise.all([
    Employee.countDocuments({ companyId, isDeleted: false, status: { $ne: 'exited' } }),
    Employee.countDocuments({ companyId, isDeleted: false, status: { $ne: 'exited' }, 'job.employeeType': 'field_employee' }),
    Branch.countDocuments({ companyId, isDeleted: false }),
    User.countDocuments({ companyId, isActive: true }),
    CompanySubscription.findOne({ companyId }).sort({ createdAt: -1 }).populate('planId', 'name').lean(),
    FieldVisit.countDocuments({ companyId, date: { $regex: `^${dayjs().format('YYYY-MM')}` } }),
    FieldWorkAssignment.countDocuments({ companyId, isDeleted: false, status: { $nin: ['completed', 'cancelled'] } }),
    EmployeeDocument.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)), isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$fileSize' } } },
    ]),
  ]);

  const daysToExpiry = sub && sub.endDate ? Math.max(dayjs(sub.endDate).diff(dayjs(), 'day'), 0) : null;
  return ok(res, {
    totalEmployees,
    fieldEmployees,
    branches,
    activeUsers: users,
    visitsThisMonth,
    activeAssignments,
    storageUsed: (storageAgg[0] && storageAgg[0].total) || 0,
    storageUnit: 'bytes',
    employeeLimit: sub ? sub.employeeLimit : null,
    fieldEmployeeLimit: sub ? sub.fieldEmployeeLimit : null,
    plan: sub && sub.planId ? sub.planId.name : null,
    subscriptionStatus: sub ? effectiveSubStatus(sub) : null,
    daysToExpiry,
  }, 'Company usage');
});

// GET /platform/payments/:id/invoice — invoice data for a payment
const paymentInvoice = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id)
    .populate('companyId', 'name code address gst email phone logo')
    .populate('planId', 'name monthlyPrice yearlyPrice')
    .lean();
  if (!payment) throw new ApiError(404, 'Payment not found');
  return ok(res, {
    ...payment,
    invoiceNumber: payment.invoiceNumber || `INV-${dayjs(payment.createdAt).format('YYYYMM')}-${String(payment._id).slice(-6).toUpperCase()}`,
    company: payment.companyId,
    plan: payment.planId,
  }, 'Invoice');
});

module.exports = {
  dashboard,
  listCompanies,
  createCompany,
  getCompany,
  updateCompany,
  suspendCompany,
  activateCompany,
  getCompanyFeatures,
  toggleCompanyFeature,
  createCompanyAdmin,
  resetCompanyAdminPassword,
  deleteCompany,
  listPlans,
  createPlan,
  getPlan,
  updatePlan,
  deletePlan,
  assignSubscription,
  renewSubscription,
  subscriptionHistory,
  createPaymentOrder,
  verifyPayment,
  listPayments,
  companyUsage,
  paymentInvoice,
};
