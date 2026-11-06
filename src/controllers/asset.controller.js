const Asset = require('../models/Asset');
const Employee = require('../models/Employee');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');
const { getCompanyId } = require('../utils/scope');
const crudFactory = require('../utils/crudFactory');
const { notify } = require('../services/notification.service');

const assetCrud = crudFactory(Asset, {
  label: 'Asset',
  searchFields: ['name', 'code', 'serialNumber', 'category'],
  filterFields: ['status', 'category', 'assignedTo', 'condition'],
  populate: [{ path: 'assignedTo', select: 'employeeCode personal.firstName personal.lastName' }],
  beforeCreate: async (req, data) => {
    if (!data.name) throw new ApiError(400, 'name is required');
  },
});

// POST /assets/:id/assign  { employeeId, note? }
const assignAsset = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const { employeeId } = req.body;
  if (!employeeId) throw new ApiError(400, 'employeeId is required');
  const [asset, employee] = await Promise.all([
    Asset.findOne({ _id: req.params.id, companyId, isDeleted: false }),
    Employee.findOne({ _id: employeeId, companyId, isDeleted: false }),
  ]);
  if (!asset) throw new ApiError(404, 'Asset not found');
  if (!employee) throw new ApiError(404, 'Employee not found');
  if (asset.status === 'assigned') throw new ApiError(400, 'Asset is already assigned. Return it first.');
  if (asset.status === 'retired') throw new ApiError(400, 'Asset is retired');

  asset.status = 'assigned';
  asset.assignedTo = employee._id;
  asset.assignmentHistory.push({
    employeeId: employee._id,
    assignedBy: req.user.userId,
    assignedAt: new Date(),
    note: req.body.note || null,
  });
  await asset.save();

  if (employee.userId) {
    await notify({
      companyId,
      userId: employee.userId,
      title: 'Asset assigned',
      message: `Asset "${asset.name}"${asset.serialNumber ? ` (SN: ${asset.serialNumber})` : ''} has been assigned to you.`,
      type: 'asset',
    });
  }
  return ok(res, asset, 'Asset assigned');
});

// POST /assets/:id/return  { condition?, note? }
const returnAsset = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const asset = await Asset.findOne({ _id: req.params.id, companyId, isDeleted: false });
  if (!asset) throw new ApiError(404, 'Asset not found');
  if (asset.status !== 'assigned') throw new ApiError(400, 'Asset is not currently assigned');

  const lastEntry = [...asset.assignmentHistory].reverse().find((h) => !h.returnedAt);
  if (lastEntry) {
    lastEntry.returnedAt = new Date();
    lastEntry.returnCondition = req.body.condition || null;
    if (req.body.note) lastEntry.note = req.body.note;
  }
  asset.status = req.body.condition === 'damaged' ? 'in_repair' : 'available';
  asset.assignedTo = null;
  if (req.body.condition) asset.condition = req.body.condition;
  await asset.save();
  return ok(res, asset, 'Asset returned');
});

// GET /assets/:id/history
const assetHistory = asyncHandler(async (req, res) => {
  const companyId = getCompanyId(req);
  const asset = await Asset.findOne({ _id: req.params.id, companyId, isDeleted: false })
    .populate('assignmentHistory.employeeId', 'employeeCode personal.firstName personal.lastName')
    .populate('assignmentHistory.assignedBy', 'name')
    .lean();
  if (!asset) throw new ApiError(404, 'Asset not found');
  return ok(res, asset.assignmentHistory, 'Asset assignment history');
});

module.exports = { assetCrud, assignAsset, returnAsset, assetHistory };
