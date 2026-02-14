/**
 * Crowdflash – Mobile WebSocket Client
 * Handles connection to server and incoming flash commands.
 */

class CrowdflashClient {
    constructor() {
        this.ws = null;
        this.deviceId = null;
        this.torch = new TorchController();
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 10000;
        this.heartbeatInterval = null;
        this.batteryInterval = null;
        this.onConnectionChange = null; // callback
        this.onCommand = null; // callback
    }

    /**
     * Connect to the WebSocket server
     */
    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const baseUrl = (window.CROWDFLASH_CONFIG && window.CROWDFLASH_CONFIG.BACKEND_URL)
            ? window.CROWDFLASH_CONFIG.BACKEND_URL
            : `${protocol}//${window.location.host}`;

        // Ensure URL doesn't end with slash if adding role
        const wsUrl = baseUrl.replace(/\/$/, '') + '?role=client';

        try {
            this.ws = new WebSocket(wsUrl);
        } catch (e) {
            console.error('WebSocket connection failed:', e);
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            console.log('Connected to Starcatcher server');
            this.connected = true;
            this.reconnectAttempts = 0;
            this._startHeartbeat();
            this._startBatteryReporting();
            if (this.onConnectionChange) this.onConnectionChange(true);
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this._handleMessage(data);
            } catch (e) {
                console.error('Message parse error:', e);
            }
        };

        this.ws.onclose = () => {
            console.log('Disconnected from server');
            this.connected = false;
            this._stopHeartbeat();
            this._stopBatteryReporting();
            if (this.onConnectionChange) this.onConnectionChange(false);
            this._scheduleReconnect();
        };

        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
        };
    }

    /**
     * Handle incoming messages from server
     */
    _handleMessage(data) {
        switch (data.type) {
            case 'connected':
                this.deviceId = data.id;
                console.log(`Device ID: ${this.deviceId}`);
                break;

            case 'flash_on':
                this.torch.turnOn();
                if (this.onCommand) this.onCommand('flash_on');
                break;

            case 'flash_off':
                this.torch.turnOff();
                if (this.onCommand) this.onCommand('flash_off');
                break;

            case 'flash_pattern':
                this.torch.playPattern(data.pattern);
                if (this.onCommand) this.onCommand('flash_pattern', data.pattern);
                break;

            case 'set_bpm':
                this.torch.currentBpm = data.bpm;
                if (this.onCommand) this.onCommand('set_bpm', data.bpm);
                break;

            case 'set_strobe':
                if (data.hz > 0) {
                    this.torch.startStrobe(data.hz);
                } else {
                    this.torch.stopStrobe();
                }
                if (this.onCommand) this.onCommand('set_strobe', data.hz);
                break;

            case 'emergency_stop':
                this.torch.emergencyStop();
                if (this.onCommand) this.onCommand('emergency_stop');
                break;

            case 'heartbeat_ack':
                // Server is alive
                break;

            case 'flash_pulse':
                this.torch.flashOnce(data.duration || 100);
                if (this.onCommand) this.onCommand('flash_pulse');
                break;

            case 'countdown_start':
                this._startCountdown(data.seconds);
                if (this.onCommand) this.onCommand('countdown_start');
                break;

            case 'client_count':
                if (this.onClientCountChange) this.onClientCountChange(data.count);
                break;

            case 'start_recording':
                if (this.onRecordingChange) this.onRecordingChange(true);
                break;

            case 'stop_recording':
                if (this.onRecordingChange) this.onRecordingChange(false);
                break;

            default:
                break;
        }
    }

    _startCountdown(seconds) {
        // Target Main UI Elements
        const elRippleCenter = document.querySelector('.ripple-center');
        const elH1 = document.querySelector('h1');
        const elP = document.querySelector('p');

        if (!elRippleCenter) return;

        // Store original state
        if (!this._originalIcon) this._originalIcon = elRippleCenter.innerHTML;
        if (!this._originalH1) this._originalH1 = elH1 ? elH1.innerHTML : '';

        // Reset text
        if (elH1) elH1.innerHTML = 'Countdown<br/>gestartet';
        if (elP) elP.style.opacity = '0.5';

        let remaining = seconds;

        // Render Number
        elRippleCenter.innerHTML = `<span style="font-size: 3.5rem; font-weight: 800; font-variant-numeric: tabular-nums;">${remaining}</span>`;
        elRippleCenter.classList.add('active-countdown');

        // Clear existing
        if (this.countdownInterval) clearInterval(this.countdownInterval);
        if (this.finaleTimeout) clearTimeout(this.finaleTimeout);

        this.countdownInterval = setInterval(() => {
            remaining--;

            // Update Number
            elRippleCenter.innerHTML = `<span style="font-size: 3.5rem; font-weight: 800; font-variant-numeric: tabular-nums;">${remaining}</span>`;

            // Flash & Vibrate on every second (if > 5)
            if (remaining > 5) {
                if (navigator.vibrate) navigator.vibrate(50);
                this.torch.flashOnce(50); // Sync flash
            }

            // Finale: Speed up flashing from 5s
            if (remaining === 5) {
                this._startCountdownFinale();
            }

            if (remaining <= 0) {
                clearInterval(this.countdownInterval);
                elRippleCenter.innerHTML = `<span style="font-size: 2.5rem; font-weight: 800;">GO!</span>`;

                // Full Flash
                this.torch.turnOn();

                // Restore UI after 3s
                setTimeout(() => {
                    elRippleCenter.innerHTML = this._originalIcon;
                    elRippleCenter.classList.remove('active-countdown');
                    if (elH1) elH1.innerHTML = this._originalH1;
                    if (elP) elP.style.opacity = '1';
                }, 3000);
            }
        }, 1000);
    }

    _startCountdownFinale() {
        // Accelerating flash sequence for last 5 seconds
        let delay = 500;
        const flash = async () => {
            // Check if countdown is still active
            const elRippleCenter = document.querySelector('.ripple-center');
            if (!elRippleCenter || !elRippleCenter.classList.contains('active-countdown')) return;

            await this.torch.flashOnce(50);
            if (navigator.vibrate) navigator.vibrate(50);

            // Speed up logic
            delay = Math.max(50, delay * 0.85);

            const text = elRippleCenter.textContent;
            if (text !== "GO!") {
                this.finaleTimeout = setTimeout(flash, delay);
            }
        };
        flash();
    }

    /**
     * Send a message to the server
     */
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    /**
     * Heartbeat to keep connection alive
     */
    _startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this.send({ type: 'heartbeat' });
        }, 15000);
    }

    _stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Periodically report battery level
     */
    _startBatteryReporting() {
        const report = async () => {
            const level = await this.torch.getBatteryLevel();
            if (level !== null) {
                this.send({ type: 'battery', level });
            }
        };
        report();
        this.batteryInterval = setInterval(report, 30000);
    }

    _stopBatteryReporting() {
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
    }

    /**
     * Reconnect with exponential backoff
     */
    _scheduleReconnect() {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        this.reconnectAttempts++;
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    /**
     * Dispose of all resources
     */
    dispose() {
        this._stopHeartbeat();
        this._stopBatteryReporting();
        this.torch.dispose();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// Export as global
window.CrowdflashClient = CrowdflashClient;
