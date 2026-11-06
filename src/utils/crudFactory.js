const asyncHandler = require('./asyncHandler');
const ApiError = require('./ApiError');
const paginate = require('./paginate');
const { ok, created } = require('./ApiResponse');
const { getCompanyId } = require('./scope');

/**
 * Generates standard company-scoped CRUD handlers for simple org-setup style models.
 * options: { label, searchFields, populate, filterFields, softDelete (default true), beforeCreate, beforeUpdate,
 *            listSort (req) => sort object, afterList (req, items) => items,
 *            sortable: [whitelisted ?sort fields], sortPrefix: sort object kept in front of ?sort }
 */
const crudFactory = (Model, options = {}) => {
  const {
    label = Model.modelName,
    searchFields = ['name'],
    populate = undefined,
    filterFields = [],
    softDelete = true,
    beforeCreate = null,
    beforeUpdate = null,
    listSort = null,
    afterList = null,
    sortable = undefined,
    sortPrefix = undefined,
  } = options;

  const baseFilter = (req) => {
    const filter = { companyId: getCompanyId(req) };
    if (softDelete) filter.isDeleted = false;
    for (const f of filterFields) {
      if (req.query[f] !== undefined && req.query[f] !== '') filter[f] = req.query[f];
    }
    return filter;
  };

  const list = asyncHandler(async (req, res) => {
    const { items, pagination } = await paginate(req.query, Model, baseFilter(req), {
      searchFields,
      populate,
      ...(sortable ? { sortable } : {}),
      ...(sortPrefix ? { sortPrefix } : {}),
      ...(listSort ? { sort: listSort(req) } : {}),
    });
    return ok(res, afterList ? await afterList(req, items) : items, `${label} list`, pagination);
  });

  const get = asyncHandler(async (req, res) => {
    let query = Model.findOne({ _id: req.params.id, companyId: getCompanyId(req) });
    if (populate) query = query.populate(populate);
    const doc = await query;
    if (!doc || (softDelete && doc.isDeleted)) throw new ApiError(404, `${label} not found`);
    return ok(res, doc, `${label} detail`);
  });

  const create = asyncHandler(async (req, res) => {
    const data = { ...req.body, companyId: getCompanyId(req) };
    if (beforeCreate) await beforeCreate(req, data);
    const doc = await Model.create(data);
    res.locals.auditEntityId = doc._id;
    return created(res, doc, `${label} created`);
  });

  const update = asyncHandler(async (req, res) => {
    const doc = await Model.findOne({ _id: req.params.id, companyId: getCompanyId(req) });
    if (!doc || (softDelete && doc.isDeleted)) throw new ApiError(404, `${label} not found`);
    const data = { ...req.body };
    delete data.companyId;
    delete data._id;
    if (beforeUpdate) await beforeUpdate(req, data, doc);
    Object.assign(doc, data);
    await doc.save();
    return ok(res, doc, `${label} updated`);
  });

  const remove = asyncHandler(async (req, res) => {
    const doc = await Model.findOne({ _id: req.params.id, companyId: getCompanyId(req) });
    if (!doc || (softDelete && doc.isDeleted)) throw new ApiError(404, `${label} not found`);
    if (softDelete) {
      doc.isDeleted = true;
      await doc.save();
    } else {
      await doc.deleteOne();
    }
    return ok(res, null, `${label} deleted`);
  });

  return { list, get, create, update, remove };
};

module.exports = crudFactory;
