const Task = require('../models/Task');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId, isManagerial } = require('../utils/scope');
const { notify } = require('../services/notification.service');
const { ROLES, TASK_STATUS } = require('../constants');

const POPULATE = [
  { path: 'assignedTo', select: 'employeeCode personal.firstName personal.lastName userId' },
  { path: 'assignedBy', select: 'name' },
];

// POST /tasks (manager+)
const createTask = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { title, assignedTo } = req.body;
  if (!title || !assignedTo) throw new ApiError(400, 'title and assignedTo are required');
  const employee = await Employee.findOne({ _id: assignedTo, companyId, isDeleted: false });
  if (!employee) throw new ApiError(404, 'Assignee employee not found');

  const task = await Task.create({
    companyId,
    title,
    description: req.body.description || '',
    assignedTo,
    assignedBy: req.user.userId,
    projectId: req.body.projectId || null,
    dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
    priority: req.body.priority || 'medium',
  });
  if (employee.userId) {
    await notify({
      companyId,
      userId: employee.userId,
      title: 'New task assigned',
      message: `Task "${title}" has been assigned to you${req.body.dueDate ? ` (due ${req.body.dueDate})` : ''}.`,
      type: 'task',
      meta: { taskId: task._id },
    });
  }
  return created(res, task, 'Task created');
});

// GET /tasks
const listTasks = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId, isDeleted: false };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.assignedTo = req.user.employeeId;
  } else if (req.query.assignedTo) {
    filter.assignedTo = req.query.assignedTo;
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;
  if (req.query.projectId) filter.projectId = req.query.projectId;
  const { items, pagination } = await paginate(req.query, Task, filter, {
    searchFields: ['title', 'description'],
    populate: POPULATE,
  });
  return ok(res, items, 'Tasks', pagination);
});

// GET /tasks/:id
const getTask = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { _id: req.params.id, companyId, isDeleted: false };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) filter.assignedTo = req.user.employeeId;
  const task = await Task.findOne(filter).populate(POPULATE);
  if (!task) throw new ApiError(404, 'Task not found');
  return ok(res, task, 'Task detail');
});

// PUT /tasks/:id (manager+)
const updateTask = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const task = await Task.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!task) throw new ApiError(404, 'Task not found');
  const updatable = ['title', 'description', 'dueDate', 'priority', 'assignedTo'];
  for (const key of updatable) {
    if (req.body[key] !== undefined) task[key] = req.body[key];
  }
  await task.save();
  return ok(res, task, 'Task updated');
});

// PATCH /tasks/:id/status  { status, comment? }
const updateStatus = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { status } = req.body;
  if (!TASK_STATUS.includes(status)) throw new ApiError(400, `Invalid status. Allowed: ${TASK_STATUS.join(', ')}`);
  const filter = { _id: req.params.id, companyId, isDeleted: false };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) filter.assignedTo = req.user.employeeId;
  const task = await Task.findOne(filter).populate('assignedTo', 'userId');
  if (!task) throw new ApiError(404, 'Task not found');
  if (['completed', 'cancelled'].includes(task.status)) {
    throw new ApiError(400, `Task is already '${task.status}'`);
  }
  if (status === 'cancelled' && !isManagerial(req.user.role)) {
    throw new ApiError(403, 'Only managers can cancel tasks');
  }
  task.status = status;
  if (status === 'completed') task.completedAt = new Date();
  if (req.body.comment) task.comments.push({ by: req.user.userId, byName: req.user.name, message: req.body.comment });
  await task.save();

  await notify({
    companyId,
    userId: task.assignedBy,
    title: 'Task update',
    message: `Task "${task.title}" is now '${status}'.`,
    type: 'task',
    meta: { taskId: task._id },
  });
  return ok(res, task, `Task moved to '${status}'`);
});

// POST /tasks/:id/comments  { message }
const addComment = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  if (!req.body.message) throw new ApiError(400, 'message is required');
  const filter = { _id: req.params.id, companyId, isDeleted: false };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) filter.assignedTo = req.user.employeeId;
  const task = await Task.findOne(filter);
  if (!task) throw new ApiError(404, 'Task not found');
  task.comments.push({ by: req.user.userId, byName: req.user.name, message: req.body.message });
  await task.save();
  return ok(res, task, 'Comment added');
});

// DELETE /tasks/:id (manager+)
const deleteTask = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const task = await Task.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!task) throw new ApiError(404, 'Task not found');
  task.isDeleted = true;
  await task.save();
  return ok(res, null, 'Task deleted');
});

module.exports = { createTask, listTasks, getTask, updateTask, updateStatus, addComment, deleteTask };
