'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const path = require('path');
const YAML = require('yamljs');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const apiRoutes = require('./routes/api');

// Initialize Express
const app = express();

// Security & Body Parsing Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve standalone demo page on /, /admin, and /demo
app.use('/', express.static(path.join(__dirname, '../public')));
app.use('/admin', express.static(path.join(__dirname, '../public')));
app.use('/demo', express.static(path.join(__dirname, '../public')));

// Database Connection
mongoose.connect(config.mongoUri)
  .then(() => {
    console.log('Successfully connected to Central DEMI MongoDB');
  })
  .catch((err) => {
    console.error('Error connecting to Central DEMI MongoDB:', err.message);
  });

// Mount Swagger Documentation UI
try {
  const swaggerDocument = YAML.load(path.join(__dirname, 'swagger/swagger.yaml'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} catch (err) {
  console.error('Failed to load Swagger specification:', err.message);
}

// Mount Central API Routes
app.use('/api', apiRoutes);

// Catch 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('Central API Error:', err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

module.exports = app;
