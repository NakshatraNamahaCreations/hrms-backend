const dayjs = require('dayjs');
const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Designation = require('../models/Designation');
const Shift = require('../models/Shift');
const Holiday = require('../models/Holiday');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const crudFactory = require('../utils/crudFactory');
const { getCompanyId } = require('../utils/scope');

// Annotates list rows with `employeeCount` — non-deleted employees referencing the row via `jobField`.
const withEmployeeCount = (jobField) => async (req, items) => {
  if (!items.length) return items;
  const counts = await Employee.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(String(getCompanyId(req))),
        isDeleted: false,
        [jobField]: { $in: items.map((i) => i._id) },
      },
    },
    { $group: { _id: `$${jobField}`, count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
  return items.map((i) => ({ ...i, employeeCount: countMap.get(String(i._id)) || 0 }));
};

const branches = crudFactory(Branch, {
  label: 'Branch',
  searchFields: ['name', 'code', 'city'],
  afterList: withEmployeeCount('job.branchId'),
});

const departments = crudFactory(Department, {
  label: 'Department',
  searchFields: ['name', 'code'],
  populate: [{ path: 'headId', select: 'employeeCode personal.firstName personal.lastName' }],
  afterList: withEmployeeCount('job.departmentId'),
});

const designations = crudFactory(Designation, {
  label: 'Designation',
  searchFields: ['name'],
  filterFields: ['departmentId'],
  populate: [{ path: 'departmentId', select: 'name' }],
  afterList: withEmployeeCount('job.designationId'),
});

const shifts = crudFactory(Shift, {
  label: 'Shift',
  searchFields: ['name'],
  beforeCreate: async (req, data) => {
    if (!data.startTime || !data.endTime) throw new ApiError(400, 'startTime and endTime are required (HH:mm)');
  },
});

const holidays = crudFactory(Holiday, {
  label: 'Holiday',
  searchFields: ['name'],
  filterFields: ['year', 'type'],
  beforeCreate: async (req, data) => {
    if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
      throw new ApiError(400, 'date is required in YYYY-MM-DD format');
    }
    data.year = dayjs(data.date).year();
  },
  beforeUpdate: async (req, data) => {
    if (data.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new ApiError(400, 'date must be YYYY-MM-DD');
      data.year = dayjs(data.date).year();
    }
  },
});

module.exports = { branches, departments, designations, shifts, holidays };
