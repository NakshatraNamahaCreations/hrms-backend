const mongoose = require('mongoose');
const { COMPANY_STATUS } = require('../constants');

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    companyType: {
      type: String,
      enum: [
        'proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited',
        'opc', 'huf', 'society', 'trust', 'ngo', 'government', 'other',
      ],
      default: null,
    },
    logo: { type: String, default: null },
    address: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      country: { type: String, default: 'India' },
      pincode: String,
    },
    gst: { type: String, default: null },
    pan: { type: String, default: null },
    cin: { type: String, default: null },
    contactPerson: {
      name: { type: String, default: null },
      phone: { type: String, default: null },
      email: { type: String, default: null },
    },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: null },
    status: { type: String, enum: COMPANY_STATUS, default: 'active' },
    settings: {
      attendance: {
        graceMinutes: { type: Number, default: 15 },
        halfDayHours: { type: Number, default: 4 },
        fullDayHours: { type: Number, default: 8 },
        allowWebCheckIn: { type: Boolean, default: true },
        allowMobileCheckIn: { type: Boolean, default: true },
        requireLocation: { type: Boolean, default: false },
      },
      geoFencing: {
        enabled: { type: Boolean, default: true },
        radiusMeters: { type: Number, default: 5 },
        allowOutsideWithReason: { type: Boolean, default: true },
        requireManagerApproval: { type: Boolean, default: true },
        requireSelfie: { type: Boolean, default: true },
      },
      trackingIntervalMinutes: { type: Number, default: 60 },
      officeTimings: {
        startTime: { type: String, default: '09:30' },
        endTime: { type: String, default: '18:30' },
      },
      weekOffDays: { type: [Number], default: [0] }, // 0=Sunday ... 6=Saturday
      leavePolicy: {
        casual: { type: Number, default: 12 },
        sick: { type: Number, default: 8 },
        earned: { type: Number, default: 15 },
      },
      leave: {
        approvalLevels: { type: Number, enum: [1, 2, 3], default: 1 }, // L1 manager → L2 hr_admin → L3 company_admin
        level3MinDays: { type: Number, default: 5 }, // leaves of this length escalate to L3 when approvalLevels >= 2
      },
      employeeCode: {
        prefix: { type: String, default: 'EMP', trim: true, uppercase: true },
        nextNumber: { type: Number, default: 1, min: 1 },
        padding: { type: Number, default: 4, min: 2, max: 8 },
      },
      payroll: {
        pfPercent: { type: Number, default: 12 },
        esiPercent: { type: Number, default: 0.75 },
        esiWageLimit: { type: Number, default: 21000 },
        professionalTax: { type: Number, default: 200 },
        ptWageThreshold: { type: Number, default: 15000 },
        fieldAllowancePerDay: { type: Number, default: 150 },
        travelAllowancePerKm: { type: Number, default: 4 },
        payDay: { type: Number, default: 1 },
      },
    },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Company', companySchema);
