const dayjs = require('dayjs');

const fmtDate = (d) => (d ? dayjs(d).format('DD MMM YYYY') : '____');
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const baseLayout = ({ company, title, body }) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0F172A; margin: 0; background: #F1F5F9; }
  .page { max-width: 800px; margin: 24px auto; background: #fff; border-radius: 12px; padding: 48px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .header { display: flex; justify-content: space-between; border-bottom: 3px solid #1E3A8A; padding-bottom: 16px; margin-bottom: 32px; }
  .company-name { font-size: 22px; font-weight: 700; color: #1E3A8A; }
  .muted { color: #64748B; font-size: 13px; }
  h1 { font-size: 20px; color: #1E3A8A; text-align: center; text-transform: uppercase; letter-spacing: 1px; }
  p { line-height: 1.7; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  th, td { border: 1px solid #E2E8F0; padding: 8px 12px; text-align: left; }
  th { background: #F1F5F9; }
  .signature { margin-top: 64px; }
  .footer { margin-top: 48px; border-top: 1px solid #E2E8F0; padding-top: 12px; font-size: 12px; color: #64748B; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <div class="company-name">${company.name}</div>
      <div class="muted">${[company.address && company.address.line1, company.address && company.address.city, company.address && company.address.state].filter(Boolean).join(', ') || ''}</div>
    </div>
    <div class="muted">Date: ${fmtDate(new Date())}</div>
  </div>
  ${body}
  <div class="signature">
    <p>For <strong>${company.name}</strong></p>
    <br/><br/>
    <p><strong>Authorized Signatory</strong></p>
  </div>
  <div class="footer">This is a system generated document. ${company.email || ''} ${company.phone ? ' | ' + company.phone : ''}</div>
</div>
</body>
</html>`;

const employeeName = (e) => `${e.personal.firstName} ${e.personal.lastName || ''}`.trim();

const templates = {
  offer: ({ company, employee, designation, ctc }) =>
    baseLayout({
      company,
      title: 'Offer Letter',
      body: `
      <h1>Offer Letter</h1>
      <p>Dear <strong>${employeeName(employee)}</strong>,</p>
      <p>We are pleased to offer you the position of <strong>${designation || 'Employee'}</strong> at
      <strong>${company.name}</strong>. Your annual CTC will be <strong>${inr(ctc || employee.salary.ctc)}</strong>.</p>
      <p>Your tentative date of joining is <strong>${fmtDate(employee.job.joiningDate)}</strong>.
      This offer is subject to satisfactory verification of your documents and background.</p>
      <p>We look forward to having you on our team.</p>`,
    }),

  appointment: ({ company, employee, designation }) =>
    baseLayout({
      company,
      title: 'Appointment Letter',
      body: `
      <h1>Appointment Letter</h1>
      <p>Dear <strong>${employeeName(employee)}</strong>,</p>
      <p>With reference to your application and subsequent interviews, we are pleased to appoint you as
      <strong>${designation || 'Employee'}</strong> at <strong>${company.name}</strong>, effective
      <strong>${fmtDate(employee.job.joiningDate)}</strong>.</p>
      <table>
        <tr><th>Employee Code</th><td>${employee.employeeCode}</td></tr>
        <tr><th>Designation</th><td>${designation || '-'}</td></tr>
        <tr><th>Date of Joining</th><td>${fmtDate(employee.job.joiningDate)}</td></tr>
        <tr><th>Annual CTC</th><td>${inr(employee.salary.ctc)}</td></tr>
      </table>
      <p>Your employment will be governed by the policies of the company as amended from time to time.</p>`,
    }),

  experience: ({ company, employee, designation, lastWorkingDate }) =>
    baseLayout({
      company,
      title: 'Experience Letter',
      body: `
      <h1>Experience Certificate</h1>
      <p><strong>TO WHOMSOEVER IT MAY CONCERN</strong></p>
      <p>This is to certify that <strong>${employeeName(employee)}</strong> (Employee Code:
      <strong>${employee.employeeCode}</strong>) was employed with <strong>${company.name}</strong> as
      <strong>${designation || 'Employee'}</strong> from <strong>${fmtDate(employee.job.joiningDate)}</strong>
      to <strong>${fmtDate(lastWorkingDate || employee.exitDate)}</strong>.</p>
      <p>During the tenure, we found ${employee.personal.gender === 'female' ? 'her' : 'him'} to be sincere,
      hardworking and professional. We wish ${employee.personal.gender === 'female' ? 'her' : 'him'} success
      in all future endeavours.</p>`,
    }),

  relieving: ({ company, employee, designation, lastWorkingDate }) =>
    baseLayout({
      company,
      title: 'Relieving Letter',
      body: `
      <h1>Relieving Letter</h1>
      <p>Dear <strong>${employeeName(employee)}</strong>,</p>
      <p>This is with reference to your resignation. We confirm that you have been relieved from the services of
      <strong>${company.name}</strong> as <strong>${designation || 'Employee'}</strong>, effective close of business on
      <strong>${fmtDate(lastWorkingDate || employee.exitDate)}</strong>.</p>
      <p>All dues will be settled as per company policy. We thank you for your contribution and wish you the best.</p>`,
    }),

  confirmation: ({ company, employee, designation }) =>
    baseLayout({
      company,
      title: 'Confirmation Letter',
      body: `
      <h1>Confirmation Letter</h1>
      <p>Dear <strong>${employeeName(employee)}</strong>,</p>
      <p>We are pleased to inform you that, having successfully completed your probation period, your
      employment with <strong>${company.name}</strong> stands confirmed as
      <strong>${designation || 'Employee'}</strong>, effective <strong>${fmtDate(new Date())}</strong>.</p>
      <table>
        <tr><th>Employee Code</th><td>${employee.employeeCode}</td></tr>
        <tr><th>Designation</th><td>${designation || '-'}</td></tr>
        <tr><th>Date of Joining</th><td>${fmtDate(employee.job.joiningDate)}</td></tr>
        <tr><th>Confirmation Date</th><td>${fmtDate(new Date())}</td></tr>
      </table>
      <p>All other terms and conditions of your appointment remain unchanged. We appreciate your
      contribution and look forward to your continued association with us.</p>`,
    }),

  increment: ({ company, employee, designation, currentCtc, newCtc, incrementPercent, effectiveDate }) => {
    const fromCtc = Number(currentCtc != null ? currentCtc : employee.salary.ctc) || 0;
    const toCtc = Number(newCtc) || fromCtc;
    const percent = incrementPercent != null && incrementPercent !== ''
      ? Number(incrementPercent)
      : (fromCtc > 0 ? Math.round(((toCtc - fromCtc) / fromCtc) * 10000) / 100 : 0);
    return baseLayout({
      company,
      title: 'Increment Letter',
      body: `
      <h1>Increment Letter</h1>
      <p>Dear <strong>${employeeName(employee)}</strong>,</p>
      <p>In recognition of your performance and contribution as <strong>${designation || 'Employee'}</strong> at
      <strong>${company.name}</strong>, we are pleased to revise your compensation effective
      <strong>${fmtDate(effectiveDate)}</strong>.</p>
      <table>
        <tr><th>Employee Code</th><td>${employee.employeeCode}</td></tr>
        <tr><th>Designation</th><td>${designation || '-'}</td></tr>
        <tr><th>Current Annual CTC</th><td>${inr(fromCtc)}</td></tr>
        <tr><th>Revised Annual CTC</th><td>${inr(toCtc)}</td></tr>
        <tr><th>Increment</th><td>${percent}%</td></tr>
        <tr><th>Effective Date</th><td>${fmtDate(effectiveDate)}</td></tr>
      </table>
      <p>All other terms and conditions of your employment remain unchanged. We thank you for your
      dedication and look forward to your continued contribution.</p>`,
    });
  },

  salary_certificate: ({ company, employee, designation }) =>
    baseLayout({
      company,
      title: 'Salary Certificate',
      body: `
      <h1>Salary Certificate</h1>
      <p><strong>TO WHOMSOEVER IT MAY CONCERN</strong></p>
      <p>This is to certify that <strong>${employeeName(employee)}</strong> (Employee Code:
      <strong>${employee.employeeCode}</strong>) is employed with <strong>${company.name}</strong> as
      <strong>${designation || 'Employee'}</strong> since <strong>${fmtDate(employee.job.joiningDate)}</strong>.</p>
      <table>
        <tr><th>Component</th><th>Monthly Amount</th></tr>
        <tr><td>Basic</td><td>${inr(employee.salary.basic)}</td></tr>
        <tr><td>HRA</td><td>${inr(employee.salary.hra)}</td></tr>
        <tr><td>Conveyance</td><td>${inr(employee.salary.conveyance)}</td></tr>
        <tr><td>Medical Allowance</td><td>${inr(employee.salary.medicalAllowance)}</td></tr>
        <tr><td>Special Allowance</td><td>${inr(employee.salary.specialAllowance)}</td></tr>
        <tr><td>Other Allowances</td><td>${inr(employee.salary.otherAllowances)}</td></tr>
        <tr><th>Annual CTC</th><th>${inr(employee.salary.ctc)}</th></tr>
      </table>
      <p>This certificate is issued upon the request of the employee.</p>`,
    }),
};

const payslipTemplate = ({ company, employee, payroll, designation, department }) => {
  const monthName = dayjs(`${payroll.year}-${String(payroll.month).padStart(2, '0')}-01`).format('MMMM YYYY');
  const e = payroll.earnings || {};
  const d = payroll.deductions || {};
  return baseLayout({
    company,
    title: `Payslip ${monthName}`,
    body: `
    <h1>Payslip — ${monthName}</h1>
    <table>
      <tr><th>Employee</th><td>${employeeName(employee)} (${employee.employeeCode})</td>
          <th>Designation</th><td>${designation || '-'}</td></tr>
      <tr><th>Department</th><td>${department || '-'}</td>
          <th>Bank A/C</th><td>${(employee.bank && employee.bank.accountNumber) || '-'}</td></tr>
      <tr><th>Days in Month</th><td>${payroll.totalDays}</td>
          <th>Payable Days</th><td>${payroll.payableDays} (LOP: ${payroll.lopDays})</td></tr>
    </table>
    <table>
      <tr><th colspan="2">Earnings</th><th colspan="2">Deductions</th></tr>
      <tr><td>Basic</td><td>${inr(e.basic)}</td><td>PF</td><td>${inr(d.pf)}</td></tr>
      <tr><td>HRA</td><td>${inr(e.hra)}</td><td>ESI</td><td>${inr(d.esi)}</td></tr>
      <tr><td>Conveyance</td><td>${inr(e.conveyance)}</td><td>Professional Tax</td><td>${inr(d.professionalTax)}</td></tr>
      <tr><td>Medical</td><td>${inr(e.medicalAllowance)}</td><td>TDS</td><td>${inr(d.tds)}</td></tr>
      <tr><td>Special Allowance</td><td>${inr(e.specialAllowance)}</td><td>LOP</td><td>${inr(d.lopAmount)}</td></tr>
      <tr><td>Other Allowances</td><td>${inr(e.otherAllowances)}</td><td>Other</td><td>${inr(d.other)}</td></tr>
      <tr><td>Field Allowance</td><td>${inr(e.fieldAllowance)}</td><td></td><td></td></tr>
      <tr><td>Travel Allowance</td><td>${inr(e.travelAllowance)}</td><td></td><td></td></tr>
      <tr><th>Gross Earnings</th><th>${inr(e.gross)}</th><th>Total Deductions</th><th>${inr(d.total)}</th></tr>
    </table>
    <h2 style="text-align:right;color:#16A34A;">Net Pay: ${inr(payroll.netSalary)}</h2>`,
  });
};

// Printable Form 16 (Part B, basic) — aggregates one financial year (Apr–Mar).
const form16Template = ({ company, employee, designation, fy, months, gross, basic, hra, otherAllowances, deductions, netTotal }) => {
  const d = deductions || {};
  return baseLayout({
    company,
    title: `Form 16 (Part B) — FY ${fy}-${(fy + 1) % 100}`,
    body: `
    <h1>Form 16 — Part B (FY ${fy}-${(fy + 1) % 100})</h1>
    <table>
      <tr><th>Employee</th><td>${employeeName(employee)} (${employee.employeeCode})</td>
          <th>Designation</th><td>${designation || '-'}</td></tr>
      <tr><th>Financial Year</th><td>${fy}-${fy + 1} (Apr–Mar)</td>
          <th>Months Paid</th><td>${months}</td></tr>
    </table>
    <table>
      <tr><th colspan="2">Income from Salary</th></tr>
      <tr><td>Basic</td><td>${inr(basic)}</td></tr>
      <tr><td>House Rent Allowance</td><td>${inr(hra)}</td></tr>
      <tr><td>Other Allowances</td><td>${inr(otherAllowances)}</td></tr>
      <tr><th>Gross Salary</th><th>${inr(gross)}</th></tr>
    </table>
    <table>
      <tr><th colspan="2">Deductions</th></tr>
      <tr><td>Provident Fund</td><td>${inr(d.pf)}</td></tr>
      <tr><td>ESI</td><td>${inr(d.esi)}</td></tr>
      <tr><td>Professional Tax</td><td>${inr(d.professionalTax)}</td></tr>
      <tr><td>TDS</td><td>${inr(d.tds)}</td></tr>
    </table>
    <h2 style="text-align:right;color:#16A34A;">Net Salary Paid: ${inr(netTotal)}</h2>
    <p class="muted">This is a system generated statement of salary paid and tax deducted, for reference only.</p>`,
  });
};

module.exports = { templates, payslipTemplate, form16Template, baseLayout };
