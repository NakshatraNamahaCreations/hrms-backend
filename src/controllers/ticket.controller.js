const Ticket = require('../models/Ticket');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isAdminRole } = require('../utils/scope');
const { notify } = require('../services/notification.service');
const { notifyRoles } = require('../services/notification.service');
const { ROLES, TICKET_TRANSITIONS, TICKET_STATUS, TICKET_CATEGORIES } = require('../constants');

const POPULATE = [
  { path: 'raisedBy', select: 'name email' },
  { path: 'assignedTo', select: 'name email' },
  { path: 'employeeId', select: 'employeeCode personal.firstName personal.lastName' },
];

const nextTicketNumber = async (companyId) => {
  const count = await Ticket.countDocuments({ companyId });
  return `TKT-${String(count + 1).padStart(5, '0')}`;
};

// POST /tickets
const createTicket = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { subject, category } = req.body;
  if (!subject) throw new ApiError(400, 'subject is required');
  if (category && !TICKET_CATEGORIES.includes(category)) {
    throw new ApiError(400, `category must be one of: ${TICKET_CATEGORIES.join(', ')}`);
  }
  const ticket = await Ticket.create({
    companyId,
    employeeId: req.user.employeeId || null,
    raisedBy: req.user.userId,
    ticketNumber: await nextTicketNumber(companyId),
    category: category || 'other',
    subject,
    description: req.body.description || '',
    priority: req.body.priority || 'medium',
  });
  await notifyRoles({
    companyId,
    roles: [ROLES.HR_ADMIN, ROLES.COMPANY_ADMIN],
    title: 'New helpdesk ticket',
    message: `${ticket.ticketNumber}: ${subject} (${ticket.category})`,
    type: 'ticket',
    meta: { ticketId: ticket._id },
  });
  return created(res, ticket, 'Ticket created');
});

// super_admin may operate WITHOUT a companyId (platform helpdesk — all companies);
// everyone else stays scoped to their own company.
const ticketScope = (req) => {
  const companyId = getCompanyId(req, { required: false });
  return companyId ? { companyId } : {};
};

// GET /tickets — super_admin without ?companyId sees every company's tickets
const listTickets = asyncHandler(async (req, res) => {
  const filter = { ...ticketScope(req), isDeleted: false };
  if (![ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN].includes(req.user.role)) {
    filter.$or = [{ raisedBy: req.user.userId }, { assignedTo: req.user.userId }];
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.priority) filter.priority = req.query.priority;
  const populate = req.user.role === ROLES.SUPER_ADMIN
    ? [...POPULATE, { path: 'companyId', select: 'name' }]
    : POPULATE;
  const { items, pagination } = await paginate(req.query, Ticket, filter, {
    searchFields: ['subject', 'ticketNumber'],
    sortable: ['createdAt', 'updatedAt', 'subject', 'ticketNumber', 'status', 'priority', 'category'],
    populate,
  });
  return ok(res, items, 'Tickets', pagination);
});

// GET /tickets/:id
const getTicket = asyncHandler(async (req, res) => {
  const filter = { _id: req.params.id, ...ticketScope(req), isDeleted: false };
  if (![ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN].includes(req.user.role)) {
    filter.$or = [{ raisedBy: req.user.userId }, { assignedTo: req.user.userId }];
  }
  const populate = req.user.role === ROLES.SUPER_ADMIN
    ? [...POPULATE, { path: 'companyId', select: 'name' }]
    : POPULATE;
  const ticket = await Ticket.findOne(filter).populate(populate);
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  return ok(res, ticket, 'Ticket detail');
});

// PATCH /tickets/:id/status  { status, comment? }
const updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!TICKET_STATUS.includes(status)) throw new ApiError(400, `Invalid status. Allowed: ${TICKET_STATUS.join(', ')}`);
  const ticket = await Ticket.findOne({ _id: req.params.id, ...ticketScope(req), isDeleted: false });
  if (!ticket) throw new ApiError(404, 'Ticket not found');

  // employees may only close their own resolved tickets
  if (!isAdminRole(req.user.role) && req.user.role !== ROLES.MANAGER) {
    const isOwner = String(ticket.raisedBy) === String(req.user.userId);
    if (!isOwner || status !== 'closed') {
      throw new ApiError(403, 'You can only close your own resolved tickets');
    }
  }

  const allowed = TICKET_TRANSITIONS[ticket.status] || [];
  if (!allowed.includes(status)) {
    throw new ApiError(400, `Cannot move ticket from '${ticket.status}' to '${status}'. Allowed: ${allowed.join(', ') || 'none'}`);
  }
  ticket.status = status;
  if (status === 'resolved') ticket.resolvedAt = new Date();
  if (status === 'closed') ticket.closedAt = new Date();
  if (req.body.comment) ticket.comments.push({ by: req.user.userId, byName: req.user.name, message: req.body.comment });
  await ticket.save();

  await notify({
    companyId: ticket.companyId,
    userId: ticket.raisedBy,
    title: 'Ticket update',
    message: `Ticket ${ticket.ticketNumber} is now '${status}'.`,
    type: 'ticket',
    meta: { ticketId: ticket._id },
  });
  return ok(res, ticket, `Ticket moved to '${status}'`);
});

// PATCH /tickets/:id/assign  { assignedTo }
const assignTicket = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  if (!req.body.assignedTo) throw new ApiError(400, 'assignedTo (userId) is required');
  const ticket = await Ticket.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  ticket.assignedTo = req.body.assignedTo;
  if (ticket.status === 'open') ticket.status = 'in_progress';
  await ticket.save();
  await notify({
    companyId,
    userId: req.body.assignedTo,
    title: 'Ticket assigned to you',
    message: `Ticket ${ticket.ticketNumber}: ${ticket.subject}`,
    type: 'ticket',
    meta: { ticketId: ticket._id },
  });
  return ok(res, ticket, 'Ticket assigned');
});

// POST /tickets/:id/comments  { message }
const addComment = asyncHandler(async (req, res) => {
  if (!req.body.message) throw new ApiError(400, 'message is required');
  const filter = { _id: req.params.id, ...ticketScope(req), isDeleted: false };
  if (![ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN].includes(req.user.role)) {
    filter.$or = [{ raisedBy: req.user.userId }, { assignedTo: req.user.userId }];
  }
  const ticket = await Ticket.findOne(filter);
  if (!ticket) throw new ApiError(404, 'Ticket not found');
  ticket.comments.push({ by: req.user.userId, byName: req.user.name, message: req.body.message });
  if (ticket.status === 'waiting_for_employee' && String(ticket.raisedBy) === String(req.user.userId)) {
    ticket.status = 'in_progress';
  }
  await ticket.save();
  return ok(res, ticket, 'Comment added');
});

module.exports = { createTicket, listTickets, getTicket, updateStatus, assignTicket, addComment };
