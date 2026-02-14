const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Middleware
app.use(express.json());

// CORS Configuration
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://crowdflash-admin.netlify.app',
  'https://crowdflash-mobile.netlify.app'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Filename');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

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

// --- Video Upload API ---
app.post('/api/upload', (req, res) => {
  const filename = req.headers['x-filename'] || `video-${Date.now()}.webm`;
  const safeFilename = path.basename(filename).replace(/[^a-z0-9.-]/gi, '_');
  const filePath = path.join(UPLOADS_DIR, safeFilename);

  const writeStream = fs.createWriteStream(filePath);

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    log('SYS', `Video uploaded: ${safeFilename}`);
    res.json({ success: true, filename: safeFilename });
  });

  writeStream.on('error', (err) => {
    console.error('Upload Error:', err);
    res.status(500).json({ success: false, message: 'Upload failed' });
  });
});

app.get('/api/videos', (req, res) => {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) {
      return res.status(500).json({ success: false, files: [] });
    }
    const videoFiles = files.filter(f => f.endsWith('.webm') || f.endsWith('.mp4')).map(f => ({
      name: f,
      url: `/uploads/${f}`,
      time: fs.statSync(path.join(UPLOADS_DIR, f)).mtime
    })).sort((a, b) => b.time - a.time);

    res.json({ success: true, files: videoFiles });
  });
});

// DELETE single or multiple videos
app.delete('/api/videos', (req, res) => {
  const { filenames } = req.body; // Array of filenames to delete
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return res.status(400).json({ success: false, message: 'No filenames provided' });
  }

  let deleted = 0;
  let errors = 0;

  for (const name of filenames) {
    const safeName = path.basename(name);
    const filePath = path.join(UPLOADS_DIR, safeName);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch (e) {
      console.error('Delete error:', safeName, e);
      errors++;
    }
  }

  log('SYS', `Deleted ${deleted} video(s)${errors > 0 ? ` (${errors} errors)` : ''}`);
  res.json({ success: true, deleted, errors });
});

// ZIP download all videos
app.get('/api/videos/zip', (req, res) => {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Cannot read uploads' });
    }
    const videoFiles = files.filter(f => f.endsWith('.webm') || f.endsWith('.mp4'));
    if (videoFiles.length === 0) {
      return res.status(404).json({ success: false, message: 'No videos to download' });
    }

    const zipName = `starcatcher_videos_${Date.now()}.zip`;
    const zipPath = path.join(UPLOADS_DIR, zipName);
    const fileList = videoFiles.map(f => `"${f}"`).join(' ');

    const { exec } = require('child_process');
    exec(`cd "${UPLOADS_DIR}" && zip -j "${zipPath}" ${fileList}`, (error) => {
      if (error) {
        console.error('ZIP Error:', error);
        return res.status(500).json({ success: false, message: 'Failed to create ZIP' });
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

      const readStream = fs.createReadStream(zipPath);
      readStream.pipe(res);

      readStream.on('end', () => {
        // Clean up zip file after sending
        fs.unlink(zipPath, () => { });
      });
    });
  });
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

function broadcastClientCount() {
  broadcastToClients({ type: 'client_count', count: clients.size });
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

function pushDeviceListToAdmins() {
  const deviceList = [];
  clients.forEach(c => {
    deviceList.push({
      id: c.id,
      battery: c.battery,
      connectedAt: c.connectedAt,
      ip: c.ip
    });
  });
  broadcastToAdmins({ type: 'device_list', devices: deviceList });
}

function disconnectClient(targetId) {
  let found = false;
  clients.forEach((info, ws) => {
    if (info.id === targetId) {
      ws.close(); // Close connection
      clients.delete(ws); // Cleanup immediately (though close event will also trigger)
      found = true;
      log('CMD', `Admin disconnected device ${targetId}`);
    }
  });
  if (found) {
    pushMetricsToAdmins();
    pushDeviceListToAdmins();
  }
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
    pushDeviceListToAdmins(); // Send initial list
    ws.send(JSON.stringify({ type: 'log_history', entries: eventLog.slice(0, 30) }));
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
    // Capture IP
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    clients.set(ws, {
      id,
      battery: null,
      connectedAt: Date.now(),
      ip: ip
    });

    log('NET', `+1 new connection (${id}) – Total: ${clients.size}`);
    pushMetricsToAdmins();
    pushDeviceListToAdmins(); // Update list

    // Acknowledge connection
    ws.send(JSON.stringify({ type: 'connected', id }));
    broadcastClientCount();

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
      pushDeviceListToAdmins(); // Update list
      broadcastClientCount();
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

    case 'countdown_start':
      broadcastToClients({ type: 'countdown_start', seconds: data.seconds });
      log('CMD', `Countdown started: ${data.seconds}s`);
      break;

    case 'flash_pulse':
      broadcastToClients({ type: 'flash_pulse', duration: data.duration });
      // Log only occasionally if needed, or omit to avoid spamming logs
      break;

    case 'disconnect_client':
      disconnectClient(data.id);
      break;

    case 'start_recording':
      broadcastToClients({ type: 'start_recording' });
      log('CMD', '🎬 Recording started on all devices');
      break;

    case 'stop_recording':
      broadcastToClients({ type: 'stop_recording' });
      log('CMD', '⏹️ Recording stopped on all devices');
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
      // Optionally throttle device list updates if battery changes too often
      // pushDeviceListToAdmins(); 
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
