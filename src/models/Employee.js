const mongoose = require('mongoose');
const { EMPLOYEE_TYPES, EMPLOYEE_STATUS, ONBOARDING_STATUS, CONFIRMATION_STATUS } = require('../constants');

const employeeSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    employeeCode: { type: String, required: true, trim: true },
    onboardingStatus: { type: String, enum: ONBOARDING_STATUS, default: 'pending' },
    personal: {
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, default: '', trim: true },
      email: { type: String, required: true, lowercase: true, trim: true },
      phone: { type: String, default: null },
      dob: { type: Date, default: null },
      gender: { type: String, enum: ['male', 'female', 'other', null], default: null },
      maritalStatus: { type: String, default: null },
      bloodGroup: { type: String, default: null },
      address: { type: String, default: null },
      emergencyContact: { name: String, phone: String, relation: String },
      photo: { type: String, default: null },
    },
    job: {
      branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
      departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
      designationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation', default: null },
      shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
      managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
      joiningDate: { type: Date, default: null },
      probationEndDate: { type: Date, default: null },
      // defaulted in pre-validate: 'probation' when probationEndDate is set, else 'confirmed'
      confirmationStatus: { type: String, enum: [...CONFIRMATION_STATUS, null], default: null },
      employmentType: {
        type: String,
        enum: ['full_time', 'part_time', 'contract', 'intern'],
        default: 'full_time',
      },
      employeeType: { type: String, enum: EMPLOYEE_TYPES, default: 'office_employee' },
      workLocation: { type: String, default: null },
    },
    salary: {
      ctc: { type: Number, default: 0 },
      basic: { type: Number, default: 0 },
      hra: { type: Number, default: 0 },
      conveyance: { type: Number, default: 0 },
      medicalAllowance: { type: Number, default: 0 },
      specialAllowance: { type: Number, default: 0 },
      otherAllowances: { type: Number, default: 0 },
      pfApplicable: { type: Boolean, default: true },
      esiApplicable: { type: Boolean, default: false },
      ptApplicable: { type: Boolean, default: true },
      tdsPercent: { type: Number, default: 0 },
    },
    bank: {
      accountHolderName: String,
      accountNumber: String,
      bankName: String,
      ifsc: String,
      branch: String,
      upiId: String,
    },
    field: {
      isFieldEmployee: { type: Boolean, default: false },
      vehicleType: { type: String, enum: ['bike', 'car', 'public_transport', 'walk', null], default: null },
      fieldAllowancePerDay: { type: Number, default: 0 },
      travelAllowancePerKm: { type: Number, default: 0 },
      trackingEnabled: { type: Boolean, default: true },
    },
    biometricUserId: { type: String, default: null },
    status: { type: String, enum: EMPLOYEE_STATUS, default: 'active' },
    exitDate: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

employeeSchema.index({ companyId: 1, employeeCode: 1 }, { unique: true });
employeeSchema.index({ companyId: 1, biometricUserId: 1 });
employeeSchema.index({ companyId: 1, 'job.employeeType': 1, status: 1 });

employeeSchema.pre('validate', function defaultConfirmationStatus(next) {
  if (this.job && !this.job.confirmationStatus) {
    this.job.confirmationStatus = this.job.probationEndDate ? 'probation' : 'confirmed';
  }
  next();
});

employeeSchema.virtual('fullName').get(function fullName() {
  return `${this.personal.firstName} ${this.personal.lastName || ''}`.trim();
});

module.exports = mongoose.model('Employee', employeeSchema);
