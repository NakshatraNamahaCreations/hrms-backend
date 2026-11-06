const express = require('express');
const visits = require('../controllers/fieldVisit.controller');
const locations = require('../controllers/fieldLocation.controller');
const expenses = require('../controllers/fieldExpense.controller');
const { auth, requireRole } = require('../middleware/auth');
const subscriptionCheck = require('../middleware/subscriptionCheck');
const { requireFeature } = require('../middleware/requireFeature');
const { upload } = require('../middleware/upload');
const { ROLES, FEATURES } = require('../constants');

const MANAGERS = [ROLES.COMPANY_ADMIN, ROLES.HR_ADMIN, ROLES.MANAGER, ROLES.SUPER_ADMIN];

// ---- /field/visits ----------------------------------------------------------
const visitsRouter = express.Router();
visitsRouter.use(auth, subscriptionCheck, requireFeature(FEATURES.FIELD_TRACKING));

const proofUpload = upload.fields([
  { name: 'photos', maxCount: 10 },
  { name: 'selfie', maxCount: 1 },
  { name: 'signature', maxCount: 1 },
]);

visitsRouter.post(
  '/check-in',
  requireRole(ROLES.FIELD_EMPLOYEE),
  upload.fields([{ name: 'selfie', maxCount: 1 }]),
  visits.checkIn
);
visitsRouter.get('/summary', visits.summary);
visitsRouter.get('/daily-summary', visits.summary); // admin panel alias
visitsRouter.get('/', visits.listVisits);
// Proof/signature/checkout accept either /:id or, from the mobile app, no id +
// workAssignmentId in the body (resolved to the active checked-in visit).
visitsRouter.post(['/proofs', '/signature', '/:id/proof', '/:id/proofs', '/:id/signature'],
  requireRole(ROLES.FIELD_EMPLOYEE), proofUpload, visits.uploadProof);
visitsRouter.post(['/checkout', '/:id/checkout'], requireRole(ROLES.FIELD_EMPLOYEE), visits.checkout);
visitsRouter.patch('/:id/approval', requireRole(...MANAGERS), visits.actOnApproval);
visitsRouter.patch('/:id/proof-verify', requireRole(...MANAGERS), visits.verifyProof);
visitsRouter.get('/:id', visits.getVisit);

// ---- /field/locations ---------------------------------------------------------
const locationsRouter = express.Router();
locationsRouter.use(auth, subscriptionCheck, requireFeature(FEATURES.LIVE_LOCATION_TRACKING));

locationsRouter.post('/bulk', requireRole(ROLES.FIELD_EMPLOYEE), locations.bulkIngest);
locationsRouter.get('/route', requireRole(...MANAGERS), locations.getRoute);
locationsRouter.get('/live', requireRole(...MANAGERS), locations.liveLocations);
locationsRouter.get('/', requireRole(...MANAGERS), locations.getRoute); // admin panel alias

// ---- /field/expenses ------------------------------------------------------------
const expensesRouter = express.Router();
expensesRouter.use(auth, subscriptionCheck, requireFeature(FEATURES.EXPENSE_MANAGEMENT));

expensesRouter.post('/', requireRole(ROLES.FIELD_EMPLOYEE, ROLES.EMPLOYEE), upload.single('receipt'), expenses.submitExpense);
expensesRouter.get('/', expenses.listExpenses);
expensesRouter.patch('/:id/approve', requireRole(...MANAGERS), expenses.approveExpense);
expensesRouter.patch('/:id/reject', requireRole(...MANAGERS), expenses.rejectExpense);
expensesRouter.patch('/:id/mark-paid', requireRole(ROLES.PAYROLL_ADMIN, ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN), expenses.markPaid);

module.exports = { visitsRouter, locationsRouter, expensesRouter };
