const Course = require('../models/Course');
const CourseAssignment = require('../models/CourseAssignment');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { ok, created } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const { notify } = require('../services/notification.service');
const { ROLES, COURSE_TYPES } = require('../constants');

const EMPLOYEE_SELECT = 'employeeCode personal.firstName personal.lastName userId';

// POST /training/courses (HR+)
const createCourse = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { title, type, url } = req.body;
  if (!title) throw new ApiError(400, 'title is required');
  if (!COURSE_TYPES.includes(type)) throw new ApiError(400, `type must be one of: ${COURSE_TYPES.join(', ')}`);
  if (!url) throw new ApiError(400, 'url is required');

  const course = await Course.create({
    companyId,
    title,
    type,
    url,
    description: req.body.description || '',
    durationMinutes: Number(req.body.durationMinutes) || 0,
    active: req.body.active !== undefined ? Boolean(req.body.active) : true,
    createdBy: req.user.userId,
  });
  return created(res, course, 'Course created');
});

// GET /training/courses — employees see active only
const listCourses = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const filter = { companyId, isDeleted: false };
  if ([ROLES.EMPLOYEE, ROLES.FIELD_EMPLOYEE].includes(req.user.role)) {
    filter.active = true;
  } else if (req.query.active !== undefined) {
    filter.active = req.query.active === 'true';
  }
  if (req.query.type) filter.type = req.query.type;
  const { items, pagination } = await paginate(req.query, Course, filter, {
    searchFields: ['title', 'description'],
  });
  return ok(res, items, 'Courses', pagination);
});

// PUT /training/courses/:id (HR+)
const updateCourse = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const course = await Course.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!course) throw new ApiError(404, 'Course not found');
  if (req.body.type && !COURSE_TYPES.includes(req.body.type)) {
    throw new ApiError(400, `type must be one of: ${COURSE_TYPES.join(', ')}`);
  }
  const updatable = ['title', 'type', 'url', 'description', 'durationMinutes', 'active'];
  for (const key of updatable) {
    if (req.body[key] !== undefined) course[key] = req.body[key];
  }
  await course.save();
  return ok(res, course, 'Course updated');
});

// DELETE /training/courses/:id (HR+)
const deleteCourse = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const course = await Course.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!course) throw new ApiError(404, 'Course not found');
  course.isDeleted = true;
  await course.save();
  return ok(res, null, 'Course deleted');
});

// POST /training/assign { courseId, employeeIds[], dueDate? } (HR+) — notifies each employee
const assignCourse = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { courseId, employeeIds } = req.body;
  if (!courseId) throw new ApiError(400, 'courseId is required');
  if (!Array.isArray(employeeIds) || !employeeIds.length) throw new ApiError(400, 'employeeIds[] is required');

  const course = await Course.findOne({ _id: courseId, companyId, isDeleted: false, active: true });
  if (!course) throw new ApiError(404, 'Course not found or inactive');
  const employees = await Employee.find({ _id: { $in: employeeIds }, companyId, isDeleted: false })
    .select(EMPLOYEE_SELECT)
    .lean();
  if (!employees.length) throw new ApiError(404, 'No matching employees found');

  let assigned = 0;
  let skipped = 0;
  for (const employee of employees) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await CourseAssignment.findOne({ courseId: course._id, employeeId: employee._id });
    if (existing) {
      skipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await CourseAssignment.create({
      companyId,
      courseId: course._id,
      employeeId: employee._id,
      dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
      assignedBy: req.user.userId,
    });
    assigned += 1;
    if (employee.userId) {
      // eslint-disable-next-line no-await-in-loop
      await notify({
        companyId,
        userId: employee.userId,
        title: 'New training assigned',
        message: `Training "${course.title}" has been assigned to you${req.body.dueDate ? ` (due ${req.body.dueDate})` : ''}.`,
        type: 'training',
        meta: { courseId: course._id },
      });
    }
  }
  return created(res, { courseId: course._id, assigned, skipped }, `Course assigned to ${assigned} employee(s)`);
});

// GET /training/my — own assignments populated with the course
const myAssignments = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const filter = { companyId, employeeId: req.user.employeeId };
  if (req.query.status) filter.status = req.query.status;
  const { items, pagination } = await paginate(req.query, CourseAssignment, filter, {
    populate: [{ path: 'courseId' }],
  });
  return ok(res, items, 'My training', pagination);
});

// PATCH /training/assignments/:id/complete — own assignment
const completeAssignment = asyncHandler(async (req, res) => {
  if (!req.user.employeeId) throw new ApiError(400, 'No employee profile linked to your account');
  const companyId = req.user.companyId;
  const assignment = await CourseAssignment.findOne({
    _id: req.params.id,
    companyId,
    employeeId: req.user.employeeId,
  }).populate('courseId', 'title');
  if (!assignment) throw new ApiError(404, 'Assignment not found');
  if (assignment.status === 'completed') throw new ApiError(400, 'Course is already completed');
  assignment.status = 'completed';
  assignment.completedAt = new Date();
  await assignment.save();
  return ok(res, assignment, 'Course completed');
});

// GET /training/courses/:id/progress (HR+) — per-employee assigned/completed
const courseProgress = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const course = await Course.findOne({ _id: req.params.id, companyId, isDeleted: false }).lean();
  if (!course) throw new ApiError(404, 'Course not found');

  const assignments = await CourseAssignment.find({ companyId, courseId: course._id })
    .populate('employeeId', EMPLOYEE_SELECT)
    .sort({ createdAt: 1 })
    .lean();
  const items = assignments.map((a) => ({
    _id: a._id,
    employee: a.employeeId
      ? {
          _id: a.employeeId._id,
          employeeCode: a.employeeId.employeeCode,
          name: `${a.employeeId.personal.firstName} ${a.employeeId.personal.lastName || ''}`.trim(),
        }
      : null,
    status: a.status,
    dueDate: a.dueDate,
    completedAt: a.completedAt,
  }));
  const totals = {
    assigned: items.length,
    completed: items.filter((i) => i.status === 'completed').length,
  };
  return ok(res, { course: { _id: course._id, title: course.title, type: course.type }, items, totals }, 'Course progress');
});

module.exports = {
  createCourse,
  listCourses,
  updateCourse,
  deleteCourse,
  assignCourse,
  myAssignments,
  completeAssignment,
  courseProgress,
};
