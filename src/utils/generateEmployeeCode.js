const Employee = require('../models/Employee');
const Company = require('../models/Company');

/**
 * Generates the next sequential employee code for a company, e.g. EMP0007.
 *
 * Uses the company's configured `settings.employeeCode` { prefix, nextNumber, padding }
 * (falling back to defaults prefix 'EMP', padding 4, nextNumber 1 when absent). The starting
 * sequence is max(nextNumber, currentEmployeeCount + 1); the first non-colliding code wins.
 * The advanced series (seq + 1) is persisted back via Company.updateOne with $set so other
 * settings are not clobbered. An explicit `prefix` override takes priority over the company's.
 */
const generateEmployeeCode = async (companyId, prefix) => {
  const company = await Company.findById(companyId).select('settings.employeeCode').lean();
  const cfg = (company && company.settings && company.settings.employeeCode) || {};

  const effectivePrefix = prefix || cfg.prefix || 'EMP';
  const padding = cfg.padding || 4;
  const nextNumber = cfg.nextNumber || 1;

  const count = await Employee.countDocuments({ companyId });
  let seq = Math.max(nextNumber, count + 1);

  // ensure uniqueness even after deletions / manual codes
  // eslint-disable-next-line no-await-in-loop, no-constant-condition
  while (true) {
    const code = `${effectivePrefix}${String(seq).padStart(padding, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await Employee.exists({ companyId, employeeCode: code });
    if (!exists) {
      // persist the advanced series without clobbering other settings
      await Company.updateOne({ _id: companyId }, { $set: { 'settings.employeeCode.nextNumber': seq + 1 } });
      return code;
    }
    seq += 1;
  }
};

module.exports = generateEmployeeCode;
