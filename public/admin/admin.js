/**
 * Starcatcher – Admin CMS Controller
 * Connects to the WebSocket server and provides real-time control.
 */

// ---- Global Auth & Logout Logic ----
window.crowdflashLogout = function () {
    console.warn('Logging out...');
    localStorage.removeItem('crowdflash_token');
    window.location.href = 'login.html';
};

(function () {
    'use strict';

    // ---- Auth Check ----
    const token = localStorage.getItem('crowdflash_token');
    if (!token && window.location.pathname.indexOf('login.html') === -1) {
        window.location.href = 'login.html';
        return;
    }

    // ---- State ----
    let ws = null;
    let connected = false;
    let shouldReconnect = true; // Flag to stop reconnection loop on auth failure
    let activeUsers = 0;
    let userHistory = [];
    let tapTimes = [];
    let currentPattern = null;
    let triggerActive = false;
    // New State
    let bpmInterval = null;
    let audioContext = null;
    let audioSource = null;
    let audioAnalyser = null;
    let isAudioPlaying = false;
    let audioThreshold = 50;
    let lastBeatTime = 0;
    // Devices State
    let allDevices = [];
    let locationCache = new Map();
    let currentSort = { field: 'time', dir: 'desc' };

    // ---- DOM References ----
    const elActiveUsers = document.getElementById('active-users');
    const elUsersChange = document.getElementById('users-change');
    const elStability = document.getElementById('stability');
    const elAvgBattery = document.getElementById('avg-battery');
    const elSparkline = document.getElementById('sparkline-path');
    const elSystemDot = document.getElementById('system-dot');
    const elSystemStatus = document.getElementById('system-status');
    const elMasterTrigger = document.getElementById('master-trigger');
    const elBpmValue = document.getElementById('bpm-value');
    const elStrobeSlider = document.getElementById('strobe-slider');
    const elStrobeDisplay = document.getElementById('strobe-display');
    const elEventLog = document.getElementById('event-log');
    const elVenueMap = document.getElementById('venue-map');
    // New DOM
    const elBtnBpmFlash = document.getElementById('btn-bpm-flash');
    const elAudioFile = document.getElementById('audio-file');
    const elAudioPlayer = document.getElementById('audio-player');
    const elAudioThreshold = document.getElementById('audio-threshold');
    const elThresholdDisplay = document.getElementById('threshold-display');
    const elBeatIndicator = document.getElementById('beat-indicator');
    const elCountdownSlider = document.getElementById('countdown-slider');
    const elCountdownDisplay = document.getElementById('countdown-display');
    const elBtnStartCountdown = document.getElementById('btn-start-countdown');
    // Devices DOM
    const elDeviceListBody = document.getElementById('device-list-body');
    const elDeviceSearch = document.getElementById('device-search');
    const elBtnRefreshDevices = document.getElementById('btn-refresh-devices');
    const navItems = document.querySelectorAll('.nav-item');
    const panelConsole = document.querySelector('.console-panel');
    const panelDevices = document.querySelector('.devices-panel');
    const btnLogout = document.getElementById('btn-logout');

    // ---- WebSocket Connection ----
    function connectWS() {
        if (!shouldReconnect) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const baseUrl = (window.CROWDFLASH_CONFIG && window.CROWDFLASH_CONFIG.BACKEND_URL)
            ? window.CROWDFLASH_CONFIG.BACKEND_URL
            : `${protocol}//${window.location.host}`;

        // Ensure URL doesn't end with slash if adding role
        const wsUrl = baseUrl.replace(/\/$/, '') + `?role=admin&token=${token}`;

        console.log('Connecting to WS...');
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WS Connected');
            connected = true;
            if (elSystemDot) elSystemDot.classList.remove('offline');
            if (elSystemStatus) elSystemStatus.textContent = 'Venue System: ONLINE';
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // CRITICAL: Handle Unauthorized (Auth failure)
                if (data.type === 'error' && data.message === 'Unauthorized') {
                    console.error('Unauthorized access. Redirecting to login.');
                    shouldReconnect = false; // STOP Loop
                    window.crowdflashLogout(); // Force Logout
                    return;
                }

                handleMessage(data);
            } catch (e) { console.error('WS Error:', e); }
        };

        ws.onclose = (e) => {
            console.log('WS Closed', e.code, e.reason);
            connected = false;
            if (elSystemDot) elSystemDot.classList.add('offline');
            if (elSystemStatus) elSystemStatus.textContent = 'Venue System: OFFLINE';

            // Only reconnect if we haven't been explicitly kicked out
            if (shouldReconnect) {
                setTimeout(connectWS, 2000);
            }
        };

        ws.onerror = (e) => { console.error('WS Error', e); };
    }

    function send(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    // ---- Message Handler ----
    function handleMessage(data) {
        switch (data.type) {
            case 'metrics':
                updateMetrics(data);
                break;
            case 'log_entry':
                addLogEntry(data.entry);
                break;
            case 'log_history':
                if (data.entries) {
                    // Clear and populate
                    if (elEventLog) {
                        elEventLog.innerHTML = '';
                        data.entries.forEach(e => addLogEntry(e));
                    }
                }
                break;
            case 'device_list':
                allDevices = data.devices || [];
                renderDeviceList();
                fetchLocations();
                break;
        }
    }

    // ---- Metrics ----
    function updateMetrics(data) {
        if (!elActiveUsers) return;

        const prev = activeUsers;
        activeUsers = data.activeUsers || 0;

        // Animate number
        animateNumber(elActiveUsers, prev, activeUsers);

        // Percentage change
        if (prev > 0) {
            const pct = Math.round(((activeUsers - prev) / prev) * 100);
            elUsersChange.textContent = (pct >= 0 ? '+' : '') + pct + '%';
            elUsersChange.className = 'metric-badge ' + (pct >= 0 ? 'positive' : 'warning');
        }

        // Sparkline
        userHistory.push(activeUsers);
        if (userHistory.length > 20) userHistory.shift();
        updateSparkline();

        // Stability
        const stab = data.stability || 0;
        if (elStability) elStability.textContent = stab.toFixed(1) + '%';
        updateStabilityBars(stab);

        // Battery
        const batt = data.avgBattery || 0;
        if (elAvgBattery) elAvgBattery.textContent = batt + '%';

        // Venue dots
        updateVenueDots(activeUsers);
    }

    function animateNumber(el, from, to) {
        const duration = 400;
        const start = Date.now();
        const step = () => {
            const progress = Math.min((Date.now() - start) / duration, 1);
            const current = Math.round(from + (to - from) * easeOutCubic(progress));
            el.textContent = current.toLocaleString();
            if (progress < 1) requestAnimationFrame(step);
        };
        step();
    }

    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    function updateSparkline() {
        if (!elSparkline || userHistory.length < 2) return;
        const maxVal = Math.max(...userHistory, 1);
        const points = userHistory.map((v, i) => {
            const x = (i / (userHistory.length - 1)) * 100;
            const y = 40 - (v / maxVal) * 35;
            return `${x},${y}`;
        });
        const d = `M${points[0]} ` + points.slice(1).map(p => `L${p}`).join(' ');
        elSparkline.setAttribute('d', d);
    }

    function updateStabilityBars(pct) {
        const filled = Math.round((pct / 100) * 5);
        for (let i = 1; i <= 5; i++) {
            const bar = document.getElementById('stab-' + i);
            if (bar) {
                bar.className = 'stability-bar' + (i > filled ? ' dim' : '');
            }
        }
    }

    function updateVenueDots(count) {
        if (!elVenueMap) return;
        // Remove old dots
        const existingDots = elVenueMap.querySelectorAll('.venue-dot');
        existingDots.forEach(d => d.remove());

        // Generate dots based on count (max 50 visual dots)
        const dotCount = Math.min(Math.max(count, 0), 50);
        for (let i = 0; i < dotCount; i++) {
            const dot = document.createElement('div');
            dot.className = 'venue-dot';
            dot.style.top = (15 + Math.random() * 70) + '%';
            dot.style.left = (10 + Math.random() * 80) + '%';
            // Random size variation
            const size = 4 + Math.random() * 4;
            dot.style.width = size + 'px';
            dot.style.height = size + 'px';
            elVenueMap.appendChild(dot);
        }
    }

    // ---- Event Log ----
    function addLogEntry(entry) {
        if (!elEventLog) return;
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.innerHTML = `
      <span class="log-time">${entry.time}</span>
      <span class="log-type ${entry.type}">[${entry.type}]</span>
      <span class="log-message">${entry.message}</span>
    `;
        // Prepend (newest first)
        elEventLog.insertBefore(div, elEventLog.firstChild);
        // Limit display
        while (elEventLog.children.length > 50) {
            elEventLog.removeChild(elEventLog.lastChild);
        }
    }

    // ---- Master Trigger ----
    function onTriggerDown(e) {
        e.preventDefault();
        triggerActive = true;
        if (elMasterTrigger) elMasterTrigger.classList.add('active');
        send({ type: 'flash_on' });
    }

    function onTriggerUp(e) {
        e.preventDefault();
        if (!triggerActive) return;
        triggerActive = false;
        if (elMasterTrigger) elMasterTrigger.classList.remove('active');
        send({ type: 'flash_off' });
    }

    if (elMasterTrigger) {
        elMasterTrigger.addEventListener('mousedown', onTriggerDown);
        elMasterTrigger.addEventListener('touchstart', onTriggerDown);
    }
    document.addEventListener('mouseup', onTriggerUp);
    document.addEventListener('touchend', onTriggerUp);

    // ---- Emergency Stop ----
    const btnEmergency = document.getElementById('btn-emergency');
    if (btnEmergency) {
        btnEmergency.addEventListener('click', () => {
            send({ type: 'emergency_stop' });
            // Reset all local state
            currentPattern = null;
            document.querySelectorAll('.pattern-btn').forEach(b => b.classList.remove('active'));
            if (elStrobeDisplay) elStrobeDisplay.textContent = '0 Hz';
            stopBpmFlash();
            stopAudio();
        });
    }

    // ---- Countdown ----
    if (elCountdownSlider) {
        elCountdownSlider.addEventListener('input', () => {
            elCountdownDisplay.textContent = elCountdownSlider.value + 's';
        });
    }

    if (elBtnStartCountdown) {
        elBtnStartCountdown.addEventListener('click', () => {
            const seconds = parseInt(elCountdownSlider.value);
            send({ type: 'countdown_start', seconds });
            addLogEntry({ type: 'CMD', message: `Countdown started (${seconds}s)`, time: new Date().toLocaleTimeString() });
        });
    }

    // ---- Crowd Recording ----
    let isRecordingActive = false;
    const elBtnToggleRecording = document.getElementById('btn-toggle-recording');

    if (elBtnToggleRecording) {
        elBtnToggleRecording.addEventListener('click', () => {
            isRecordingActive = !isRecordingActive;
            if (isRecordingActive) {
                send({ type: 'start_recording' });
                elBtnToggleRecording.style.background = '#ef4444';
                elBtnToggleRecording.style.borderColor = '#ef4444';
                elBtnToggleRecording.style.color = 'white';
                elBtnToggleRecording.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1.25rem;">stop_circle</span> STOP RECORDING';
            } else {
                send({ type: 'stop_recording' });
                elBtnToggleRecording.style.background = 'transparent';
                elBtnToggleRecording.style.borderColor = '#ef4444';
                elBtnToggleRecording.style.color = '#ef4444';
                elBtnToggleRecording.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1.25rem;">videocam</span> START RECORDING';
            }
        });
    }

    // ---- BPM Flash (Auto) ----
    if (elBtnBpmFlash) {
        elBtnBpmFlash.addEventListener('click', () => {
            if (bpmInterval) {
                stopBpmFlash();
            } else {
                startBpmFlash();
            }
        });
    }

    function startBpmFlash() {
        if (bpmInterval) return;
        elBtnBpmFlash.classList.add('active');
        elBtnBpmFlash.style.background = '#ef4444'; // Red to indicate stop
        elBtnBpmFlash.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1rem; vertical-align: middle;">stop</span> Stop';

        const bpm = parseInt(elBpmValue.value) || 128;
        const intervalMs = 60000 / bpm;

        // Send initial flash
        sendFlashPulse();

        bpmInterval = setInterval(() => {
            sendFlashPulse();
        }, intervalMs);
    }

    function stopBpmFlash() {
        if (!bpmInterval) return;
        clearInterval(bpmInterval);
        bpmInterval = null;
        elBtnBpmFlash.classList.remove('active');
        elBtnBpmFlash.style.background = 'var(--primary)';
        elBtnBpmFlash.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1rem; vertical-align: middle;">flash_on</span> Auto';
    }

    function sendFlashPulse() {
        send({ type: 'flash_pulse', duration: 100 });
        // Visual feedback
        if (elBtnBpmFlash) {
            elBtnBpmFlash.style.opacity = 0.5;
            setTimeout(() => elBtnBpmFlash.style.opacity = 1, 50);
        }
    }

    // Update BPM interval if changed while running
    if (elBpmValue) {
        elBpmValue.addEventListener('change', () => {
            if (bpmInterval) {
                stopBpmFlash();
                startBpmFlash();
            }
        });
    }

    // ---- Audio Sync ----
    if (elAudioFile) {
        elAudioFile.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const url = URL.createObjectURL(file);
                elAudioPlayer.src = url;
                elAudioPlayer.style.display = 'block';
                setupAudioContext();
            }
        });
    }

    if (elAudioThreshold) {
        elAudioThreshold.addEventListener('input', () => {
            audioThreshold = parseInt(elAudioThreshold.value);
            elThresholdDisplay.textContent = audioThreshold + '%';
        });
    }

    function setupAudioContext() {
        if (audioContext) return;

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
        audioSource = audioContext.createMediaElementSource(elAudioPlayer);
        audioAnalyser = audioContext.createAnalyser();
        audioAnalyser.fftSize = 256;

        audioSource.connect(audioAnalyser);
        audioAnalyser.connect(audioContext.destination);

        elAudioPlayer.addEventListener('play', () => {
            isAudioPlaying = true;
            audioContext.resume();
            analyzeAudio();
        });

        elAudioPlayer.addEventListener('pause', () => isAudioPlaying = false);
        elAudioPlayer.addEventListener('ended', () => isAudioPlaying = false);
    }

    function analyzeAudio() {
        if (!isAudioPlaying) return;

        const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
        audioAnalyser.getByteFrequencyData(dataArray);

        // Simple beat detection: check low frequencies (bass)
        // Bins 0-10 roughly correspond to bass in a 256 FFT size
        let bassSum = 0;
        for (let i = 0; i < 10; i++) {
            bassSum += dataArray[i];
        }
        const bassLevel = bassSum / 10; // 0-255

        // Threshold check (mapped 0-100 to 0-255)
        const thresholdLevel = (audioThreshold / 100) * 255;

        const now = Date.now();
        if (bassLevel > thresholdLevel && (now - lastBeatTime > 200)) { // 200ms debounce
            lastBeatTime = now;
            sendFlashPulse(); // Send flash command

            // Visual feedback
            if (elBeatIndicator) {
                elBeatIndicator.style.background = '#34d399';
                elBeatIndicator.style.transform = 'scale(1.2)';
                setTimeout(() => {
                    elBeatIndicator.style.background = '#334155';
                    elBeatIndicator.style.transform = 'scale(1)';
                }, 100);
            }
        }

        if (isAudioPlaying) requestAnimationFrame(analyzeAudio);
    }

    function stopAudio() {
        if (elAudioPlayer) {
            elAudioPlayer.pause();
            elAudioPlayer.currentTime = 0;
        }
    }

    // ---- BPM Controls ----
    const btnBpmMinus = document.getElementById('bpm-minus');
    if (btnBpmMinus) {
        btnBpmMinus.addEventListener('click', () => {
            const val = Math.max(1, parseInt(elBpmValue.value) - 1);
            elBpmValue.value = val;
            send({ type: 'set_bpm', bpm: val });
        });
    }

    const btnBpmPlus = document.getElementById('bpm-plus');
    if (btnBpmPlus) {
        btnBpmPlus.addEventListener('click', () => {
            const val = Math.min(300, parseInt(elBpmValue.value) + 1);
            elBpmValue.value = val;
            send({ type: 'set_bpm', bpm: val });
        });
    }

    if (elBpmValue) {
        elBpmValue.addEventListener('change', () => {
            const val = Math.max(1, Math.min(300, parseInt(elBpmValue.value) || 128));
            elBpmValue.value = val;
            send({ type: 'set_bpm', bpm: val });
        });
    }

    // Tap Tempo
    const btnTap = document.getElementById('btn-tap');
    if (btnTap) {
        btnTap.addEventListener('click', () => {
            const now = Date.now();
            tapTimes.push(now);
            // Keep last 8 taps
            if (tapTimes.length > 8) tapTimes.shift();
            if (tapTimes.length >= 2) {
                const intervals = [];
                for (let i = 1; i < tapTimes.length; i++) {
                    intervals.push(tapTimes[i] - tapTimes[i - 1]);
                }
                const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                const bpm = Math.round(60000 / avgInterval);
                elBpmValue.value = Math.max(1, Math.min(300, bpm));
                send({ type: 'set_bpm', bpm: parseInt(elBpmValue.value) });
            }
            // Reset after 2s of no tapping
            clearTimeout(window._tapReset);
            window._tapReset = setTimeout(() => { tapTimes = []; }, 2000);
        });
    }

    // ---- Strobe Rate ----
    if (elStrobeSlider) {
        elStrobeSlider.addEventListener('input', () => {
            const val = parseInt(elStrobeSlider.value);
            // Map 0-100 to 0-30 Hz
            const hz = Math.round((val / 100) * 30);
            elStrobeDisplay.textContent = hz + ' Hz';
            send({ type: 'set_strobe', hz });
        });
    }

    // ---- Flash Patterns ----
    document.querySelectorAll('.pattern-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const pattern = btn.dataset.pattern;

            // Toggle off if same
            if (currentPattern === pattern) {
                currentPattern = null;
                btn.classList.remove('active');
                return;
            }

            // Set new active
            currentPattern = pattern;
            document.querySelectorAll('.pattern-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            send({ type: 'flash_pattern', pattern });
        });
    });

    // ---- Init ----
    connectWS();

    // ---- File Input UI ----
    if (elAudioFile) {
        elAudioFile.addEventListener('change', (e) => {
            const fileName = e.target.files[0] ? e.target.files[0].name : 'Keine Datei ausgewählt';
            const elFileName = document.getElementById('file-name');
            if (elFileName) elFileName.textContent = fileName;
        });
    }

    // ---- Navigation & Panel Switching ----
    const pageTitle = document.getElementById('page-title');

    navItems.forEach((item) => {
        item.addEventListener('click', (e) => {
            e.preventDefault();

            // Remove active class from all nav items
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            const text = item.innerText.trim();
            if (pageTitle) pageTitle.textContent = text;

            // Hide all panels
            document.querySelectorAll('.panel-view').forEach(p => {
                p.style.display = 'none';
                p.classList.remove('active');
            });

            // Show target panel
            let targetPanelId = 'panel-overview';
            if (text.includes('Overview') || text.includes('Dashboard')) targetPanelId = 'panel-overview';
            else if (text.includes('Live Show') || text.includes('Console')) targetPanelId = 'panel-live';
            else if (text.includes('Devices')) targetPanelId = 'panel-devices';
            else if (text.includes('Analytics')) targetPanelId = 'panel-analytics';
            else if (text.includes('Videos')) targetPanelId = 'panel-videos';

            const targetPanel = document.getElementById(targetPanelId);
            if (targetPanel) {
                targetPanel.style.display = 'block';
                // Small timeout to trigger CSS animation
                setTimeout(() => targetPanel.classList.add('active'), 10);
            }

            // Auto-load videos when switching to Videos panel
            if (targetPanelId === 'panel-videos') {
                fetchVideos();
            }
        });
    });

    // ---- Video Gallery ----
    const elVideoGallery = document.getElementById('video-gallery');
    const elBtnRefreshVideos = document.getElementById('btn-refresh-videos');
    let cachedVideoFiles = [];

    function getBackendUrl() {
        const cfg = window.CROWDFLASH_CONFIG && window.CROWDFLASH_CONFIG.BACKEND_URL;
        if (cfg) {
            return cfg.replace('wss://', 'https://').replace('ws://', 'http://');
        }
        return '';
    }

    async function fetchVideos() {
        if (!elVideoGallery) return;
        elVideoGallery.innerHTML = '<div style="color: var(--text-muted); grid-column: 1/-1; text-align: center; padding: 2rem;">Loading...</div>';

        try {
            const res = await fetch(getBackendUrl() + '/api/videos');
            const data = await res.json();

            cachedVideoFiles = data.files || [];

            if (data.success && cachedVideoFiles.length > 0) {
                renderVideoGallery(cachedVideoFiles);
            } else {
                elVideoGallery.innerHTML = '<div style="color: var(--text-muted); grid-column: 1/-1; text-align: center; padding: 2rem;"><span class="material-symbols-outlined" style="font-size: 3rem; display: block; margin-bottom: 0.5rem; opacity: 0.3;">videocam_off</span>No videos recorded yet.</div>';
            }
        } catch (err) {
            console.error('Fetch videos error:', err);
            elVideoGallery.innerHTML = '<div style="color: #ef4444; grid-column: 1/-1; text-align: center; padding: 2rem;">Failed to load videos.</div>';
        }
    }

    function renderVideoGallery(files) {
        if (!elVideoGallery) return;
        const backendUrl = getBackendUrl();

        // Group by date
        const groups = {};
        files.forEach(f => {
            const date = new Date(f.time);
            const dateKey = date.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push(f);
        });

        // Bulk actions bar
        let html = `
            <div style="grid-column: 1/-1; display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem;">
                <button id="btn-bulk-download" style="display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1rem; font-size: 0.75rem; background: var(--primary); color: white; border: none; border-radius: var(--radius); cursor: pointer; font-weight: 600;">
                    <span class="material-symbols-outlined" style="font-size: 1rem;">download</span>
                    Download All (${files.length})
                </button>
                <button id="btn-delete-all" style="display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1rem; font-size: 0.75rem; background: transparent; color: #ef4444; border: 1px solid #ef4444; border-radius: var(--radius); cursor: pointer; font-weight: 600;">
                    <span class="material-symbols-outlined" style="font-size: 1rem;">delete_sweep</span>
                    Delete All
                </button>
            </div>`;

        // Render each date group
        for (const [dateKey, groupFiles] of Object.entries(groups)) {
            html += `
                <div style="grid-column: 1/-1; display: flex; align-items: center; justify-content: space-between; margin-top: 0.5rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border);">
                    <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted);">${dateKey} (${groupFiles.length})</span>
                    <button class="btn-delete-group" data-date="${dateKey}" style="display: flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem; font-size: 0.65rem; background: transparent; color: #ef4444; border: 1px solid rgba(239,68,68,0.3); border-radius: 4px; cursor: pointer;">
                        <span class="material-symbols-outlined" style="font-size: 0.85rem;">delete</span>
                        Delete Group
                    </button>
                </div>`;

            groupFiles.forEach(f => {
                const date = new Date(f.time);
                const timeStr = date.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const videoUrl = backendUrl + f.url;

                html += `
                    <div class="video-card" data-filename="${f.name}" data-date="${dateKey}" style="background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;">
                        <video src="${videoUrl}" style="width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #000;" preload="metadata"></video>
                        <div style="padding: 0.75rem;">
                            <div style="font-size: 0.75rem; color: var(--text-muted);">${timeStr}</div>
                            <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
                                <a href="${videoUrl}" target="_blank" style="flex: 1; text-align: center; padding: 0.4rem; font-size: 0.7rem; background: var(--surface-light); color: white; border-radius: 4px; text-decoration: none;">▶ Play</a>
                                <a href="${videoUrl}" download style="flex: 1; text-align: center; padding: 0.4rem; font-size: 0.7rem; background: var(--primary); color: white; border-radius: 4px; text-decoration: none;">⬇ Save</a>
                            </div>
                            <button class="btn-delete-single" data-filename="${f.name}" style="width: 100%; margin-top: 0.4rem; padding: 0.35rem; font-size: 0.65rem; background: transparent; color: #ef4444; border: 1px solid rgba(239,68,68,0.2); border-radius: 4px; cursor: pointer;">
                                <span class="material-symbols-outlined" style="font-size: 0.85rem; vertical-align: middle;">delete</span> Delete
                            </button>
                        </div>
                    </div>`;
            });
        }

        elVideoGallery.innerHTML = html;

        // Wire up bulk download
        const btnBulkDl = document.getElementById('btn-bulk-download');
        if (btnBulkDl) {
            btnBulkDl.addEventListener('click', () => bulkDownload());
        }

        // Wire up delete all
        const btnDeleteAll = document.getElementById('btn-delete-all');
        if (btnDeleteAll) {
            btnDeleteAll.addEventListener('click', () => {
                if (confirm(`Are you sure you want to delete ALL ${files.length} videos?`)) {
                    deleteVideos(files.map(f => f.name));
                }
            });
        }

        // Wire up delete group buttons
        document.querySelectorAll('.btn-delete-group').forEach(btn => {
            btn.addEventListener('click', () => {
                const dateKey = btn.dataset.date;
                const groupFiles = files.filter(f => {
                    const d = new Date(f.time);
                    return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' }) === dateKey;
                });
                if (confirm(`Delete ${groupFiles.length} video(s) from ${dateKey}?`)) {
                    deleteVideos(groupFiles.map(f => f.name));
                }
            });
        });

        // Wire up individual delete buttons
        document.querySelectorAll('.btn-delete-single').forEach(btn => {
            btn.addEventListener('click', () => {
                const filename = btn.dataset.filename;
                if (confirm(`Delete this video?`)) {
                    deleteVideos([filename]);
                }
            });
        });
    }

    async function deleteVideos(filenames) {
        try {
            const res = await fetch(getBackendUrl() + '/api/videos', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filenames })
            });
            const data = await res.json();
            if (data.success) {
                fetchVideos(); // Reload gallery
            } else {
                alert('Failed to delete videos.');
            }
        } catch (err) {
            console.error('Delete error:', err);
            alert('Error deleting videos.');
        }
    }

    function bulkDownload() {
        const backendUrl = getBackendUrl();
        const a = document.createElement('a');
        a.href = backendUrl + '/api/videos/zip';
        a.download = 'starcatcher_videos.zip';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    if (elBtnRefreshVideos) {
        elBtnRefreshVideos.addEventListener('click', fetchVideos);
    }

    // ---- Device Management ----

    async function fetchLocations() {
        // Find IPs that we don't have connection info for
        const uniqueIps = [...new Set(allDevices.map(d => d.ip).filter(ip => ip && !locationCache.has(ip)))];

        // Rate limit: process max 5 at a time
        const batch = uniqueIps.slice(0, 5);

        for (const ip of batch) {
            // Check cache again
            if (locationCache.has(ip)) continue;

            try {
                // Determine if it's a local address to avoid useless calls
                if (ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('127.')) {
                    locationCache.set(ip, 'Local Network');
                    continue;
                }

                const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,countryCode`);
                const data = await res.json();
                if (data.status === 'success') {
                    locationCache.set(ip, `${data.city}, ${data.countryCode}`);
                } else {
                    locationCache.set(ip, 'Unknown');
                }
            } catch (e) {
                console.warn('Location fetch failed', e);
            }
        }

        // Re-render if we fetched anything
        if (batch.length > 0) renderDeviceList();
    }

    function renderDeviceList() {
        if (!elDeviceListBody) return;

        // Filter
        const query = (elDeviceSearch && elDeviceSearch.value || '').toLowerCase();
        let displayList = allDevices.filter(d =>
            d.id.toLowerCase().includes(query) ||
            (d.ip && d.ip.includes(query))
        );

        // Sort
        displayList.sort((a, b) => {
            let valA, valB;
            switch (currentSort.field) {
                case 'time':
                    valA = a.connectedAt; // Older timestamp = Longer duration
                    valB = b.connectedAt;
                    return currentSort.dir === 'desc' ? (valA - valB) : (valB - valA); // Asc means oldest first (longest duration)
                case 'batt':
                    valA = a.battery || -1;
                    valB = b.battery || -1;
                    return currentSort.dir === 'desc' ? (valB - valA) : (valA - valB);
                case 'id':
                default:
                    valA = a.id;
                    valB = b.id;
                    return currentSort.dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            }
        });

        elDeviceListBody.innerHTML = '';
        const now = Date.now();

        displayList.forEach(d => {
            const tr = document.createElement('tr');

            // Duration
            const diffMin = Math.floor((now - d.connectedAt) / 60000);
            const diffSec = Math.floor(((now - d.connectedAt) % 60000) / 1000);
            const duration = `${diffMin}m ${diffSec}s`;

            // Location
            let loc = 'Checking...';
            if (d.ip) {
                loc = locationCache.get(d.ip) || (d.ip.length > 15 ? d.ip.substring(0, 15) + '...' : d.ip);
            }

            // Battery
            const battClass = (d.battery === null) ? 'text-muted' : (d.battery < 20 ? 'text-danger' : 'text-success');
            const battText = (d.battery === null) ? 'N/A' : `${d.battery}%`;

            tr.innerHTML = `
                <td><span class="mono">${d.id}</span></td>
                <td>${duration}</td>
                <td class="${battClass}">${battText}</td>
                <td>
                    <div style="line-height: 1.2;">
                        <div>${d.ip || 'Unknown'}</div>
                        <div class="location-tag">${loc}</div>
                    </div>
                </td>
                <td>
                    <button class="btn-disconnect" data-id="${d.id}">Disconnect</button>
                </td>
            `;
            elDeviceListBody.appendChild(tr);
        });

        // Bind disconnect
        document.querySelectorAll('.btn-disconnect').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.dataset.id;
                if (confirm(`Disconnect device ${id}?`)) {
                    send({ type: 'disconnect_client', id });
                }
            });
        });
    }

    // Search & Refresh listeners
    if (elDeviceSearch) {
        elDeviceSearch.addEventListener('input', renderDeviceList);
    }
    if (elBtnRefreshDevices) {
        elBtnRefreshDevices.addEventListener('click', () => {
            // Request list if needed, usually pushed by server
            renderDeviceList();
        });
    }

    // Header sorting
    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.sort;
            if (currentSort.field === field) {
                currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.field = field;
                currentSort.dir = 'desc';
            }
            renderDeviceList();
        });
    });

    // Generate initial venue dots visual
    if (elVenueMap) {
        for (let i = 0; i < 6; i++) {
            const dot = document.createElement('div');
            dot.className = 'venue-dot';
            dot.style.top = (15 + Math.random() * 70) + '%';
            dot.style.left = (10 + Math.random() * 80) + '%';
            elVenueMap.appendChild(dot);
            elVenueMap.appendChild(dot);
        }
    }

    // Logout UI Binding
    if (btnLogout) {
        // Remove valid clone logic as it might break references, just overwrite onClick
        btnLogout.onclick = function (e) {
            e.preventDefault();
            window.crowdflashLogout();
        };
        console.log("Logout button bound");
    }

})();
