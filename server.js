const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Configuration ---
const ADMIN_CREDENTIALS = {
  email: 'alexander.naumer@aroma.ch',
  password: 'Cr0wdflash'
};

// In-memory session store (simple token approach)
const activeTokens = new Set();

// Login API
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_CREDENTIALS.email && password === ADMIN_CREDENTIALS.password) {
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    activeTokens.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// --- State ---
const clients = new Map();   // ws → { id, battery, connectedAt }
const admins = new Set();     // ws set
let clientIdCounter = 0;
const eventLog = [];

function generateId() {
  clientIdCounter++;
  return `D${String(clientIdCounter).padStart(4, '0')}`;
}

function log(type, message) {
  const now = new Date();
  const ts = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = { time: ts, type, message, timestamp: Date.now() };
  eventLog.unshift(entry);
  if (eventLog.length > 100) eventLog.pop();
  // Push to all admins
  broadcastToAdmins({ type: 'log_entry', entry });
}

function getMetrics() {
  const clientCount = clients.size;
  let totalBattery = 0;
  let batteryCount = 0;
  clients.forEach(c => {
    if (c.battery != null) {
      totalBattery += c.battery;
      batteryCount++;
    }
  });
  const avgBattery = batteryCount > 0 ? Math.round(totalBattery / batteryCount) : 0;
  return {
    type: 'metrics',
    activeUsers: clientCount,
    avgBattery,
    stability: clientCount > 0 ? 99.8 : 0,
    timestamp: Date.now()
  };
}

function broadcastToClients(data) {
  const msg = JSON.stringify(data);
  clients.forEach((info, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastToAdmins(data) {
  const msg = JSON.stringify(data);
  admins.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function pushMetricsToAdmins() {
  broadcastToAdmins(getMetrics());
}

// --- WebSocket ---
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');

  if (role === 'admin') {
    // Verify token
    if (!token || !activeTokens.has(token)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      ws.close();
      return;
    }

    admins.add(ws);
    // Send current state
    ws.send(JSON.stringify(getMetrics()));
    ws.send(JSON.stringify({ type: 'log_history', entries: eventLog.slice(0, 30) }));
    log('SYS', 'Admin console connected');

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw);
        handleAdminMessage(data, ws);
      } catch (e) { /* ignore */ }
    });

    ws.on('close', () => {
      admins.delete(ws);
      log('SYS', 'Admin console disconnected');
    });

  } else {
    // Mobile client
    const id = generateId();
    clients.set(ws, { id, battery: null, connectedAt: Date.now() });
    log('NET', `+1 new connection (${id}) – Total: ${clients.size}`);
    pushMetricsToAdmins();

    // Acknowledge connection
    ws.send(JSON.stringify({ type: 'connected', id }));

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw);
        handleClientMessage(data, ws);
      } catch (e) { /* ignore */ }
    });

    ws.on('close', () => {
      const info = clients.get(ws);
      clients.delete(ws);
      if (info) {
        log('NET', `Device ${info.id} disconnected – Total: ${clients.size}`);
      }
      pushMetricsToAdmins();
    });
  }
});

function handleAdminMessage(data, ws) {
  switch (data.type) {
    case 'flash_on':
      broadcastToClients({ type: 'flash_on' });
      log('CMD', 'Master trigger: FLASH ON');
      break;

    case 'flash_off':
      broadcastToClients({ type: 'flash_off' });
      log('CMD', 'Master trigger: FLASH OFF');
      break;

    case 'flash_pattern':
      broadcastToClients({ type: 'flash_pattern', pattern: data.pattern });
      log('CMD', `Triggered pattern: ${data.pattern}`);
      break;

    case 'set_bpm':
      broadcastToClients({ type: 'set_bpm', bpm: data.bpm });
      log('SYS', `BPM updated to ${data.bpm}`);
      break;

    case 'set_strobe':
      broadcastToClients({ type: 'set_strobe', hz: data.hz });
      log('SYS', `Strobe rate set to ${data.hz} Hz`);
      break;

    case 'emergency_stop':
      broadcastToClients({ type: 'emergency_stop' });
      log('ERR', 'EMERGENCY STOP triggered – all devices reset');
      break;

    default:
      break;
  }
}

function handleClientMessage(data, ws) {
  const info = clients.get(ws);
  if (!info) return;

  switch (data.type) {
    case 'battery':
      info.battery = data.level;
      pushMetricsToAdmins();
      break;

    case 'heartbeat':
      ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
      break;

    default:
      break;
  }
}

// Periodic metrics push
setInterval(pushMetricsToAdmins, 3000);

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ⚡ Crowdflash Server running on http://localhost:${PORT}`);
  console.log(`  📱 Mobile:  http://localhost:${PORT}/`);
  console.log(`  🖥️  Admin:   http://localhost:${PORT}/admin/\n`);
});
