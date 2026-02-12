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
        elStrobeSlider.value = 0;
        elStrobeDisplay.textContent = '0 Hz';
    });

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

    // Generate initial venue dots visual
    for (let i = 0; i < 6; i++) {
        const dot = document.createElement('div');
        dot.className = 'venue-dot';
        dot.style.top = (15 + Math.random() * 70) + '%';
        dot.style.left = (10 + Math.random() * 80) + '%';
        elVenueMap.appendChild(dot);
    }

})();
