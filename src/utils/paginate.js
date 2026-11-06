/**
 * Generic pagination helper.
 * @param {object} reqQuery  req.query (?page&limit&search&sort&sortBy&sortOrder)
 * @param {import('mongoose').Model} model
 * @param {object} filter    mongoose filter (already company-scoped by caller)
 * @param {object} options   { searchFields: [], sortable: [], sortPrefix, populate, select, sort, lean }
 * @returns {Promise<{items: any[], pagination: {page,limit,total,totalPages}, finalFilter: object}>}
 *   finalFilter is the exact mongo filter the items/total were computed with
 *   (caller filter + search clauses) — reuse it for sibling aggregates (totals)
 *   so they always cover the same set as the page items.
 *
 * v1.5 server-side list contract:
 * - ?search=  case-insensitive LITERAL substring OR across options.searchFields
 *   (the term is regex-escaped and length-capped before reaching MongoDB, so a
 *   hostile or PCRE-invalid pattern can neither 500 nor burn regex CPU). When the
 *   caller's filter already uses $or (role/visibility scoping), both $or groups are
 *   AND-combined so search can never widen what a user is allowed to see.
 * - ?sort=    single-field mongoose style ('-createdAt' | 'name'). Only fields in the
 *   endpoint whitelist (options.sortable, default ['createdAt','updatedAt',...searchFields])
 *   are honored; anything else silently falls back to the default sort. An _id tiebreaker
 *   (same direction) keeps page slices stable when the sort field has duplicate values.
 *   options.sortPrefix (e.g. { pinned: -1 }) is kept in front of an explicit ?sort.
 * - Calls without ?search/?sort behave exactly as before (sortBy/sortOrder defaults).
 */

// Search terms are ALWAYS matched literally: validating with the JS RegExp
// engine is not enough (V8 and MongoDB's PCRE disagree — e.g. variable-length
// lookbehind is JS-valid but 500s in Mongo), and any syntactically valid
// catastrophic-backtracking pattern would otherwise ship verbatim to the DB
// across every searchField (ReDoS). Escape everything and cap the length.
const MAX_SEARCH_TERM_LENGTH = 256;
const buildSearchRegex = (term) => ({
  $regex: String(term).slice(0, MAX_SEARCH_TERM_LENGTH).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  $options: 'i',
});

// Parses ?sort=-field|field against the whitelist; null → use the default sort.
const parseSortParam = (raw, sortable) => {
  if (!raw) return null;
  const str = String(raw).trim();
  const desc = str.startsWith('-');
  const field = (desc ? str.slice(1) : str).trim();
  if (!field || !sortable.includes(field)) return null;
  const dir = desc ? -1 : 1;
  return { [field]: dir, _id: dir };
};

// Legacy ?sortBy field names must look like plain dotted paths — anything else
// ($-prefixed keys, qs-array injections, …) silently falls back to createdAt.
const LEGACY_SORT_FIELD = /^[A-Za-z][\w.]*$/;

const paginate = async (reqQuery, model, filter = {}, options = {}) => {
  const page = Math.max(parseInt(reqQuery.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(reqQuery.limit, 10) || 20, 1), 500);
  // Legacy ?sortBy/?sortOrder: coerce to strings (qs can deliver arrays/objects)
  // and reject unsafe field names so malicious values can never 500 the endpoint.
  const rawSortBy = String(reqQuery.sortBy || 'createdAt').trim();
  const sortBy = LEGACY_SORT_FIELD.test(rawSortBy) ? rawSortBy : 'createdAt';
  const sortOrder = String(reqQuery.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;

  const finalFilter = { ...filter };
  if (reqQuery.search && Array.isArray(options.searchFields) && options.searchFields.length) {
    const rx = buildSearchRegex(String(reqQuery.search).trim());
    const searchOr = options.searchFields.map((f) => ({ [f]: rx }));
    if (finalFilter.$or) {
      // never clobber a role/visibility $or coming from the controller
      finalFilter.$and = [...(finalFilter.$and || []), { $or: finalFilter.$or }, { $or: searchOr }];
      delete finalFilter.$or;
    } else {
      finalFilter.$or = searchOr;
    }
  }

  const sortable = Array.isArray(options.sortable) && options.sortable.length
    ? options.sortable
    : [...new Set(['createdAt', 'updatedAt', ...(options.searchFields || [])])];
  const requestedSort = parseSortParam(reqQuery.sort, sortable);
  const sort = requestedSort
    ? { ...(options.sortPrefix || {}), ...requestedSort }
    : options.sort || { [sortBy]: sortOrder };

  let query = model
    .find(finalFilter)
    .sort(sort)
    .skip((page - 1) * limit)
    .limit(limit);
  if (options.populate) query = query.populate(options.populate);
  if (options.select) query = query.select(options.select);
  if (options.lean !== false) query = query.lean();

  const [items, total] = await Promise.all([query, model.countDocuments(finalFilter)]);
  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    finalFilter,
  };
};

/**
 * v1.5 — same list contract for endpoints that COMPUTE their rows in memory
 * (e.g. /leaves/balances, /loans/outstanding). Applies ?search (case-insensitive
 * substring across the values returned by searchValues(row)), ?sort (whitelisted
 * via sortable: { field: (row) => comparable }) and OPT-IN slicing: rows are only
 * sliced when the caller explicitly sends ?page or ?limit, so legacy callers keep
 * receiving the full list (with pagination metadata added alongside).
 * @returns {{ items: any[], pagination: {page,limit,total,totalPages} }}
 */
const paginateArray = (reqQuery, rows, { searchValues = null, sortable = {} } = {}) => {
  let items = rows;

  if (reqQuery.search && typeof searchValues === 'function') {
    const needle = String(reqQuery.search).trim().toLowerCase();
    if (needle) {
      items = items.filter((row) => (searchValues(row) || [])
        .some((v) => v != null && String(v).toLowerCase().includes(needle)));
    }
  }

  const raw = String(reqQuery.sort || '').trim();
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  if (key && typeof sortable[key] === 'function') {
    const get = sortable[key];
    items = [...items].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
      return 0;
    });
  }

  const total = items.length;
  let page = 1;
  let limit = total;
  if (reqQuery.page !== undefined || reqQuery.limit !== undefined) {
    page = Math.max(parseInt(reqQuery.page, 10) || 1, 1);
    limit = Math.min(Math.max(parseInt(reqQuery.limit, 10) || 20, 1), 500);
    items = items.slice((page - 1) * limit, page * limit);
  }
  return {
    items,
    pagination: { page, limit, total, totalPages: limit ? Math.ceil(total / limit) || 1 : 1 },
  };
};

module.exports = paginate;
module.exports.paginateArray = paginateArray;
