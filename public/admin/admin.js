/**
 * Crowdflash – Admin CMS Controller
 * Connects to the WebSocket server and provides real-time control.
 */

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

    // ---- WebSocket Connection ----
    function connectWS() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const baseUrl = (window.CROWDFLASH_CONFIG && window.CROWDFLASH_CONFIG.BACKEND_URL)
            ? window.CROWDFLASH_CONFIG.BACKEND_URL
            : `${protocol}//${window.location.host}`;

        // Ensure URL doesn't end with slash if adding role
        const wsUrl = baseUrl.replace(/\/$/, '') + `?role=admin&token=${token}`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            connected = true;
            elSystemDot.classList.remove('offline');
            elSystemStatus.textContent = 'Venue System: ONLINE';
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleMessage(data);
            } catch (e) { /* ignore */ }
        };

        ws.onclose = () => {
            connected = false;
            elSystemDot.classList.add('offline');
            elSystemStatus.textContent = 'Venue System: OFFLINE';
            // Reconnect
            setTimeout(connectWS, 2000);
        };

        ws.onerror = () => { };
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
                    elEventLog.innerHTML = '';
                    data.entries.forEach(e => addLogEntry(e));
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
        elStability.textContent = stab.toFixed(1) + '%';
        updateStabilityBars(stab);

        // Battery
        const batt = data.avgBattery || 0;
        elAvgBattery.textContent = batt + '%';

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
        if (userHistory.length < 2) return;
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
        elMasterTrigger.classList.add('active');
        send({ type: 'flash_on' });
    }

    function onTriggerUp(e) {
        e.preventDefault();
        if (!triggerActive) return;
        triggerActive = false;
        elMasterTrigger.classList.remove('active');
        send({ type: 'flash_off' });
    }

    elMasterTrigger.addEventListener('mousedown', onTriggerDown);
    elMasterTrigger.addEventListener('touchstart', onTriggerDown);
    document.addEventListener('mouseup', onTriggerUp);
    document.addEventListener('touchend', onTriggerUp);

    // ---- Emergency Stop ----
    document.getElementById('btn-emergency').addEventListener('click', () => {
        send({ type: 'emergency_stop' });
        // Reset all local state
        currentPattern = null;
        document.querySelectorAll('.pattern-btn').forEach(b => b.classList.remove('active'));
        elStrobeDisplay.textContent = '0 Hz';
        stopBpmFlash();
        stopAudio();
    });

    // ---- Countdown ----
    elCountdownSlider.addEventListener('input', () => {
        elCountdownDisplay.textContent = elCountdownSlider.value + 's';
    });

    elBtnStartCountdown.addEventListener('click', () => {
        const seconds = parseInt(elCountdownSlider.value);
        send({ type: 'countdown_start', seconds });
        addLogEntry({ type: 'CMD', message: `Countdown started (${seconds}s)`, time: new Date().toLocaleTimeString() });
    });

    // ---- BPM Flash (Auto) ----
    elBtnBpmFlash.addEventListener('click', () => {
        if (bpmInterval) {
            stopBpmFlash();
        } else {
            startBpmFlash();
        }
    });

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
        elBtnBpmFlash.style.opacity = 0.5;
        setTimeout(() => elBtnBpmFlash.style.opacity = 1, 50);
    }

    // Update BPM interval if changed while running
    elBpmValue.addEventListener('change', () => {
        if (bpmInterval) {
            stopBpmFlash();
            startBpmFlash();
        }
    });

    // ---- Audio Sync ----
    elAudioFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const url = URL.createObjectURL(file);
            elAudioPlayer.src = url;
            elAudioPlayer.style.display = 'block';
            setupAudioContext();
        }
    });

    elAudioThreshold.addEventListener('input', () => {
        audioThreshold = parseInt(elAudioThreshold.value);
        elThresholdDisplay.textContent = audioThreshold + '%';
    });

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
            elBeatIndicator.style.background = '#34d399';
            elBeatIndicator.style.transform = 'scale(1.2)';
            setTimeout(() => {
                elBeatIndicator.style.background = '#334155';
                elBeatIndicator.style.transform = 'scale(1)';
            }, 100);
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
    document.getElementById('bpm-minus').addEventListener('click', () => {
        const val = Math.max(1, parseInt(elBpmValue.value) - 1);
        elBpmValue.value = val;
        send({ type: 'set_bpm', bpm: val });
    });

    document.getElementById('bpm-plus').addEventListener('click', () => {
        const val = Math.min(300, parseInt(elBpmValue.value) + 1);
        elBpmValue.value = val;
        send({ type: 'set_bpm', bpm: val });
    });

    elBpmValue.addEventListener('change', () => {
        const val = Math.max(1, Math.min(300, parseInt(elBpmValue.value) || 128));
        elBpmValue.value = val;
        send({ type: 'set_bpm', bpm: val });
    });

    // Tap Tempo
    document.getElementById('btn-tap').addEventListener('click', () => {
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

    // ---- Strobe Rate ----
    elStrobeSlider.addEventListener('input', () => {
        const val = parseInt(elStrobeSlider.value);
        // Map 0-100 to 0-30 Hz
        const hz = Math.round((val / 100) * 30);
        elStrobeDisplay.textContent = hz + ' Hz';
        send({ type: 'set_strobe', hz });
    });

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

    // ---- Navigation ----
    navItems.forEach((item, index) => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            // Logic for visual swapping
            // 0: Dashboard (Metrics + Console + Log)
            // 1: Live Show (Metrics + Console + Log) -> Same view for now
            // 2: Devices -> Hide Console, Show Devices

            if (item.innerText.includes('Devices')) {
                panelConsole.style.display = 'none';
                panelDevices.style.display = 'flex';
            } else {
                panelConsole.style.display = 'flex';
                panelDevices.style.display = 'none';
            }
        });
    });

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
        const query = (elDeviceSearch.value || '').toLowerCase();
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
    for (let i = 0; i < 6; i++) {
        const dot = document.createElement('div');
        dot.className = 'venue-dot';
        dot.style.top = (15 + Math.random() * 70) + '%';
        dot.style.left = (10 + Math.random() * 80) + '%';
        elVenueMap.appendChild(dot);
    }

})();
