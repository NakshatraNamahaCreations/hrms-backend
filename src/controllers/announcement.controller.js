const dayjs = require('dayjs');
const Announcement = require('../models/Announcement');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isManagerial } = require('../utils/scope');
const crudFactory = require('../utils/crudFactory');
const { notify } = require('../services/notification.service');

// A date-only "Expires on" value (e.g. 2026-06-30) is stored as the END of that
// day so an announcement that "expires today" stays visible all day, not just
// until midnight. Empty/blank clears the expiry.
const normalizeExpiry = (data) => {
  if (data.expiresAt === '' || data.expiresAt == null) {
    data.expiresAt = null;
    return;
  }
  data.expiresAt = dayjs(data.expiresAt).endOf('day').toDate();
};

const base = crudFactory(Announcement, {
  label: 'Announcement',
  searchFields: ['title', 'message'],
  sortable: ['createdAt', 'updatedAt', 'publishAt', 'title'],
  sortPrefix: { pinned: -1 }, // pinned stay first even under an explicit ?sort
  filterFields: ['audience', 'isActive'],
  populate: [{ path: 'publishedBy', select: 'name' }],
  // pinned announcements first, then the regular sort
  listSort: (req) => {
    const sortBy = req.query.sortBy || 'createdAt';
    const sortOrder = (req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    return { pinned: -1, [sortBy]: sortOrder };
  },
  beforeUpdate: async (req, data) => {
    normalizeExpiry(data);
  },
});

// POST /announcements — publish + fan out notifications to the targeted employees
const create = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { title, message } = req.body;
  if (!title || !message) throw new ApiError(400, 'title and message are required');

  const data = { ...req.body, companyId, publishedBy: req.user.userId };
  normalizeExpiry(data);
  const doc = await Announcement.create(data);

  // Notify the audience (in-app + push). Never let a notification failure block publishing.
  try {
    const empFilter = { companyId, isDeleted: false, status: 'active' };
    if (doc.audience === 'department' && doc.departmentIds && doc.departmentIds.length) {
      empFilter['job.departmentId'] = { $in: doc.departmentIds };
    } else if (doc.audience === 'branch' && doc.branchIds && doc.branchIds.length) {
      empFilter['job.branchId'] = { $in: doc.branchIds };
    }
    const employees = await Employee.find(empFilter).select('userId').lean();
    const userIds = employees.map((e) => e.userId).filter(Boolean);
    if (userIds.length) {
      await notify({
        companyId,
        userIds,
        title: doc.title,
        message: doc.message,
        type: 'announcement',
        meta: { announcementId: doc._id },
        channels: ['push'],
      });
    }
  } catch (e) {
    // best-effort fan-out — publishing already succeeded
  }

  res.locals.auditEntityId = doc._id;
  return created(res, doc, 'Announcement published');
});

// GET /announcements — readers see only announcements targeted to them and not expired
const listForReader = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const now = new Date();
  // Compare expiry against the START of today so a same-day (midnight-stored)
  // expiry stays visible through the whole day — keeps the reader list in step
  // with what the dashboard/home widget shows.
  const startOfToday = dayjs(now).startOf('day').toDate();
  const filter = {
    companyId,
    isDeleted: false,
    isActive: true,
    publishAt: { $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gte: startOfToday } }],
  };

  if (!isManagerial(req.user.role)) {
    const employee = req.user.employeeId
      ? await Employee.findById(req.user.employeeId).select('job.departmentId job.branchId').lean()
      : null;
    const audienceOr = [{ audience: 'all' }];
    if (employee && employee.job && employee.job.departmentId) {
      audienceOr.push({ audience: 'department', departmentIds: employee.job.departmentId });
    }
    if (employee && employee.job && employee.job.branchId) {
      audienceOr.push({ audience: 'branch', branchIds: employee.job.branchId });
    }
    filter.$and = [{ $or: audienceOr }];
  }

  const { items, pagination } = await paginate(req.query, Announcement, filter, {
    searchFields: ['title'],
    sortable: ['createdAt', 'publishAt', 'title'],
    sortPrefix: { pinned: -1 }, // pinned stay first even under an explicit ?sort
    populate: [{ path: 'publishedBy', select: 'name' }],
    sort: { pinned: -1, publishAt: -1 },
  });
  return ok(res, items, 'Announcements', pagination);
});

module.exports = { ...base, create, listForReader };
