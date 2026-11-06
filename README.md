# HRMS Backend — Multi-tenant SaaS HRMS & Field Workforce Management API

Node.js + Express + Mongoose REST API implementing the contract in `../ARCHITECTURE.md`.

## Setup

```bash
cd backend
npm install
copy .env.example .env     # then edit values (Windows: copy; Unix: cp)
npm run seed               # idempotent demo data (requires MongoDB)
npm run dev                # nodemon, http://localhost:5000
# or
npm start
```

Requires Node 18+ and MongoDB (default `mongodb://127.0.0.1:27017/hrms`).

## Environment

See `.env.example`: `PORT`, `MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`JWT_EXPIRES_IN=1d`, `JWT_REFRESH_EXPIRES_IN=30d`, `GOOGLE_MAPS_API_KEY`,
`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (absent ⇒ payment service runs in **mock mode**),
`SMTP_*` (email channel is a console stub), `CLIENT_URL`.

## Seeded logins (`npm run seed`)

| Role | Email | Password |
|---|---|---|
| super_admin | owner@hrms.com | Owner@123 |
| company_admin | admin@acme.com | Admin@123 |
| hr_admin | hr@acme.com | Hr@12345 |
| manager | manager@acme.com | Manager@123 |
| employee | john@acme.com | John@123 |
| field_employee | field@acme.com | Field@123 |
| payroll_admin | payroll@acme.com | Payroll@123 |

Plus: Basic/Standard/Premium/Enterprise plans, Acme Corp on Premium (active),
2 geo-located clients, 2 field work assignments for today, sample attendance & leaves.

## API overview (base `/api/v1`)

All responses use the envelope `{ success, message, data }` (+ `pagination` on lists).
Auth: `Authorization: Bearer <accessToken>`. Tenant scoping by `companyId` from the JWT.
Middleware chain: `auth → subscriptionCheck (402 on expired/suspended) → requireRole → requireFeature`.

| Prefix | Module |
|---|---|
| `/auth` | login, refresh-token, forgot/reset/change password, me |
| `/platform/*` | super_admin: dashboard, companies (+suspend/activate/features/admin), plans, subscriptions, payments (Razorpay mock-aware) |
| `/feature-requests` | company submits; owner transitions status (+quote/assignee) |
| `/company/profile` | company settings (attendance rules, geo-fencing, tracking interval, leave/payroll rules) |
| `/branches` `/departments` `/designations` `/shifts` `/holidays` | org setup CRUD |
| `/employees` | CRUD (creates linked User login + temp password), sections, documents, onboarding status, plan-limit enforcement |
| `/attendance` | check-in/out, today, manual bulk mark, list, monthly summary, payroll-lock guard |
| `/attendance/corrections` | employee → manager approve → HR verify (attendance upsert) |
| `/biometric` | device CRUD, `/punch` webhook (deviceKey auth) → logs + attendance upsert |
| `/clients` | client CRUD with lat/lng |
| `/work-assignments` | CRUD, `/my` groupings, status transition state machine |
| `/field/visits` | geo-fenced check-in (haversine + radius + outside-with-reason approval), proof upload, checkout (derives day attendance), proof verify |
| `/field/locations` | `/bulk` ingest (active-visit validated), `/route`, `/live` |
| `/field/expenses` | submit/approve/reject/mark-paid |
| `/leaves` | apply (balance validated), approve/reject/cancel, `/balance` (auto-init from policy) |
| `/payroll` | generate (full salary calc: LOP, PF/ESI/PT/TDS, field & travel allowance), approve, mark-paid, lock, payslip JSON + HTML |
| `/recruitment` | jobs + candidates pipeline |
| `/performance` | cycles, self/manager/HR reviews, finalize, field metrics |
| `/tasks` `/assets` `/documents` `/announcements` `/tickets` | as per contract |
| `/exits` | resignation → manager → HR → checklist → complete (deactivates employee + experience letter) |
| `/reports/:type` | JSON or `?format=csv` — employees, attendance, field-attendance, client-visits, leaves, payroll, late-coming, absent, new-joiners, exits, subscriptions*, revenue* (*super_admin) |
| `/notifications` | list own, mark read / read-all |
| `/dashboard` | role-aware stats |

Uploaded files are served from `/uploads` (stored per-company at `uploads/<companyId>/`).

## Notes

- `src/app.js` is requireable without a DB; `server.js` owns the DB connection.
- AuditLog written for: manual attendance edits & corrections, payroll approve/lock/generate, employee salary changes & deletes, company suspend/feature toggles, subscription changes, exit completion.
- Storage service (`services/storage.service.js`) is local-disk with S3/Cloudinary stub interface.
- Notification service creates in-app notifications and has email/SMS/WhatsApp/push console stubs.
