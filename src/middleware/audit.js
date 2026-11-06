const AuditLog = require('../models/AuditLog');

const SENSITIVE_KEYS = ['password', 'newPassword', 'currentPassword', 'token', 'refreshToken'];

const sanitizeBody = (body = {}) => {
  const clone = { ...body };
  for (const key of SENSITIVE_KEYS) {
    if (key in clone) clone[key] = '[REDACTED]';
  }
  return clone;
};

/**
 * Direct helper for controllers that need fine-grained audit entries.
 */
const logAudit = (req, { action, entityType, entityId, meta = {} }) => {
  if (!req.user) return;
  AuditLog.create({
    companyId: req.user.companyId || null,
    userId: req.user.userId,
    role: req.user.role,
    action,
    entityType,
    entityId: entityId ? String(entityId) : null,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    meta,
  }).catch(() => {});
};

/**
 * Route middleware: writes an AuditLog entry after a successful (2xx/3xx) response.
 * Usage: router.post('/lock', audit('payroll.lock', 'Payroll'), controller.lock)
 */
const audit = (action, entityType) => (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.user) return;
    AuditLog.create({
      companyId: req.user.companyId || null,
      userId: req.user.userId,
      role: req.user.role,
      action,
      entityType,
      entityId: String(req.params.id || res.locals.auditEntityId || ''),
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      meta: { body: sanitizeBody(req.body) },
    }).catch(() => {});
  });
  next();
};

module.exports = { audit, logAudit };
