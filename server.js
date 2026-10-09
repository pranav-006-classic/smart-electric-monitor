/**
 * Backend API Server for Smart Automated Electricity Billing and Monitoring System
 * Framework: Node.js + Express
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON Parsing
app.use(cors());
app.use(express.json());

// Serve static frontend files from current directory
app.use(express.static(path.join(__dirname)));

// Latest Meter State Store
let latestMeterReading = {
  voltage: 5.02,
  current: 0.42,
  power: 2.11,
  energy: 0.0042,
  tamper: false,
  meter_id: 'TN-MTR-001',
  timestamp: null
};

// ESP32 Connection Tracker
let hasReceivedRealESP32Data = false;
let lastESP32PostTime = null;

// Log History Store
let meterHistory = [];
let alertLogs = [];

/**
 * POST /api/meter-data
 * Endpoint for ESP32 to send JSON readings via HTTP POST.
 */
app.post('/api/meter-data', (req, res) => {
  const { voltage, current, power, energy, tamper, meter_id } = req.body;

  if (voltage === undefined || current === undefined || power === undefined) {
    return res.status(400).json({ error: 'Missing required meter data fields (voltage, current, power)' });
  }

  hasReceivedRealESP32Data = true;
  lastESP32PostTime = Date.now();

  latestMeterReading = {
    voltage: parseFloat(voltage),
    current: parseFloat(current),
    power: parseFloat(power),
    energy: parseFloat(energy || 0.0),
    tamper: Boolean(tamper),
    meter_id: meter_id || 'TN-MTR-001',
    timestamp: new Date().toISOString()
  };

  // Push to history
  meterHistory.unshift(latestMeterReading);
  if (meterHistory.length > 100) meterHistory.pop();

  // If tamper detected, store alert
  if (tamper) {
    alertLogs.unshift({
      id: `ALT-${Math.floor(1000 + Math.random() * 9000)}`,
      type: 'METER_TAMPER',
      meter_id: latestMeterReading.meter_id,
      timestamp: new Date().toLocaleTimeString(),
      rawTime: Date.now(),
      value: 'PHYSICAL SWITCH',
      status: 'ACTIVE',
      description: 'Physical push-button tamper switch triggered on ESP32!'
    });
  }

  console.log(`[ESP32 POST Received] V: ${voltage}V | I: ${current}A | P: ${power}W | Tamper: ${tamper}`);

  res.status(200).json({
    success: true,
    message: 'Meter data received successfully',
    timestamp: latestMeterReading.timestamp
  });
});

/**
 * GET /api/meter-data
 * Endpoint for Dashboard UI to retrieve the latest meter reading and connection status.
 */
app.get('/api/meter-data', (req, res) => {
  const now = Date.now();
  const isConnected = hasReceivedRealESP32Data && (lastESP32PostTime !== null) && (now - lastESP32PostTime < 6000);

  res.status(200).json({
    ...latestMeterReading,
    connected: isConnected,
    has_received_data: hasReceivedRealESP32Data,
    last_post_ms_ago: lastESP32PostTime ? (now - lastESP32PostTime) : null
  });
});

/**
 * POST /api/simulate-connection
 * Toggle simulation of physical ESP32 connecting to laptop.
 */
app.post('/api/simulate-connection', (req, res) => {
  const shouldConnect = req.body && req.body.connected !== false;
  if (shouldConnect) {
    hasReceivedRealESP32Data = true;
    lastESP32PostTime = Date.now();
    latestMeterReading = {
      voltage: 5.04,
      current: 0.43,
      power: 2.16,
      energy: (latestMeterReading.energy || 0.0042) + 0.0005,
      tamper: false,
      meter_id: 'TN-MTR-001',
      timestamp: new Date().toISOString()
    };
  } else {
    lastESP32PostTime = null;
    hasReceivedRealESP32Data = false;
  }
  res.status(200).json({
    success: true,
    connected: shouldConnect,
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/alerts
 * Endpoint to retrieve alert logs.
 */
app.get('/api/alerts', (req, res) => {
  res.status(200).json(alertLogs);
});

/**
 * DELETE /api/alerts
 * Clear all alert logs on backend.
 */
app.delete('/api/alerts', (req, res) => {
  alertLogs = [];
  res.status(200).json({ success: true, message: 'All alert logs cleared' });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===========================================================`);
  console.log(`⚡ Smart Energy Monitor Backend Server running on port ${PORT}`);
  console.log(`🌐 Dashboard URL: http://0.0.0.0:${PORT}`);
  console.log(`📡 ESP32 API Endpoint: POST http://0.0.0.0:${PORT}/api/meter-data`);
  console.log(`===========================================================`);
});
