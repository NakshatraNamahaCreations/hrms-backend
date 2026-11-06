const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

require('./models'); // register all schemas

const routes = require('./routes');
const { errorHandler, notFound } = require('./middleware/errorHandler');

const app = express();

// Reflect the request origin (works for localhost dev, the LAN IP, and the
// deployed Netlify panel). Auth is via Bearer header, but credentials:true
// keeps cookie-based flows working too.
app.use(cors({ }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// static file hosting for uploaded files
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/', (req, res) =>
  res.json({ success: true, message: 'HRMS API is running', data: { api: '/api/v1', health: 'ok' } })
);
app.get('/health', (req, res) => res.json({ success: true, message: 'OK', data: { uptime: process.uptime() } }));

app.use('/api/v1', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
