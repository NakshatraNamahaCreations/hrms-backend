const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, default: null, trim: true },
    contactPerson: { type: String, default: null },
    email: { type: String, default: null, lowercase: true, trim: true },
    phone: { type: String, default: null },
    address: { type: String, default: null },
    location: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
    geoFenceRadiusMeters: { type: Number, default: null }, // overrides company default when set
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Client', clientSchema);
