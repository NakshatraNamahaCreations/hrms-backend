const express = require('express');
const { branches, departments, designations, shifts, holidays } = require('../controllers/org.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { ROLES, FEATURES } = require('../constants');

const ORG_ADMINS = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.SUPER_ADMIN];

// Builds a CRUD router: reads for all company users, writes for org admins.
// `gateReads: false` keeps the read endpoints open even when a feature is off,
// so pickers (e.g. assigning a shift to an employee) still populate.
const buildRouter = (crud, featureKey, { gateReads = true } = {}) => {
  const router = express.Router();
  router.use(auth, subscriptionCheck);
  const feature = featureKey ? [requireFeature(featureKey)] : [];
  const readGuard = gateReads ? feature : [];

  router.get('/', ...readGuard, crud.list);
  router.get('/:id', ...readGuard, crud.get);
  router.post('/', ...feature, requireRole(...ORG_ADMINS), crud.create);
  router.put('/:id', ...feature, requireRole(...ORG_ADMINS), crud.update);
  router.delete('/:id', ...feature, requireRole(...ORG_ADMINS), crud.remove);
  return router;
};

module.exports = {
  branchesRouter: buildRouter(branches),
  departmentsRouter: buildRouter(departments),
  designationsRouter: buildRouter(designations),
  // shift reads stay open so the employee-form Shift picker always loads;
  // creating/editing shifts still requires the Shift Management feature.
  shiftsRouter: buildRouter(shifts, FEATURES.SHIFTS, { gateReads: false }),
  holidaysRouter: buildRouter(holidays, FEATURES.HOLIDAYS),
};
