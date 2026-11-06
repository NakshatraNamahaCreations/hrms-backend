const Client = require('../models/Client');
const ApiError = require('../utils/ApiError');
const crudFactory = require('../utils/crudFactory');

// Location is OPTIONAL — clients without coordinates simply skip geo-fenced
// check-in. When coordinates are given, they must be valid.
const validateLocation = (data) => {
  const loc = data.location;
  if (!loc || (loc.latitude == null && loc.longitude == null)) {
    delete data.location;
    return;
  }
  if (loc.latitude == null || loc.longitude == null) {
    throw new ApiError(400, 'Provide both latitude and longitude, or neither');
  }
  if (Math.abs(loc.latitude) > 90 || Math.abs(loc.longitude) > 180) {
    throw new ApiError(400, 'Invalid latitude/longitude values');
  }
};

const clientCrud = crudFactory(Client, {
  label: 'Client',
  searchFields: ['name', 'code', 'contactPerson', 'phone', 'address'],
  filterFields: ['isActive'],
  beforeCreate: async (req, data) => {
    if (!data.name) throw new ApiError(400, 'name is required');
    validateLocation(data);
  },
  beforeUpdate: async (req, data) => {
    validateLocation(data);
  },
});

module.exports = clientCrud;
