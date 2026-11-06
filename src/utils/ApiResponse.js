// Standard success envelope: { success: true, message, data } (+ pagination for lists)

const ok = (res, data = null, message = 'OK', pagination = undefined, statusCode = 200) => {
  const body = { success: true, message, data };
  if (pagination) body.pagination = pagination;
  return res.status(statusCode).json(body);
};

const created = (res, data = null, message = 'Created') => ok(res, data, message, undefined, 201);

module.exports = { ok, created };
