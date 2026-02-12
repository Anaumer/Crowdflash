/**
 * Crowdflash – Torch API Wrapper
 * Uses MediaDevices API to control the phone's rear flashlight (torch).
 * Falls back to screen flash (white overlay) on unsupported devices.
 */

class TorchController {
    constructor() {
        this.stream = null;
        this.track = null;
        this.isOn = false;
        this.supported = false;
        this.flashInterval = null;
        this.currentBpm = 128;
        this.currentStrobeHz = 0;
        this.currentPattern = null;
        this.patternTimeout = null;
    }

    /**
     * Request camera permission and check for torch support.
     * Returns true if torch is available.
     */
    async requestPermission() {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1 },
                    height: { ideal: 1 }
                }
            });

            this.track = this.stream.getVideoTracks()[0];
            const capabilities = this.track.getCapabilities();

            if (capabilities.torch) {
                this.supported = true;
                return true;
            } else {
                console.warn('Torch not supported on this device, using screen fallback');
                this.supported = false;
                return true; // Still allow usage with fallback
            }
        } catch (err) {
            console.error('Camera permission denied:', err);
            this.supported = false;
            return false;
        }
    }

    /**
     * Turn the torch on
     */
    async turnOn() {
        if (this.isOn) return;
        this.isOn = true;

        if (this.supported && this.track) {
            try {
                await this.track.applyConstraints({
                    advanced: [{ torch: true }]
                });
            } catch (e) {
                console.warn('Torch on failed:', e);
                this._screenFlashOn();
            }
        } else {
            this._screenFlashOn();
        }
    }

    /**
     * Turn the torch off
     */
    async turnOff() {
        if (!this.isOn) return;
        this.isOn = false;

        if (this.supported && this.track) {
            try {
                await this.track.applyConstraints({
                    advanced: [{ torch: false }]
                });
            } catch (e) {
                console.warn('Torch off failed:', e);
            }
        }
        this._screenFlashOff();
    }

    /**
     * Toggle torch
     */
    async toggle() {
        if (this.isOn) {
            await this.turnOff();
        } else {
            await this.turnOn();
        }
    }

    /**
     * Flash once (brief on/off)
     */
    async flashOnce(durationMs = 100) {
        await this.turnOn();
        return new Promise(resolve => {
            setTimeout(async () => {
                await this.turnOff();
                resolve();
            }, durationMs);
        });
    }

    /**
     * Start a strobe pattern
     */
    startStrobe(hz) {
        this.stopStrobe();
        if (hz <= 0) return;
        this.currentStrobeHz = hz;
        const intervalMs = Math.max(1000 / (hz * 2), 16); // half-period

        this.flashInterval = setInterval(async () => {
            await this.toggle();
        }, intervalMs);
    }

    /**
     * Stop the strobe
     */
    stopStrobe() {
        if (this.flashInterval) {
            clearInterval(this.flashInterval);
            this.flashInterval = null;
        }
        this.turnOff();
        this.currentStrobeHz = 0;
    }

    /**
     * Play a flash pattern
     */
    async playPattern(pattern) {
        this.stopPattern();
        this.currentPattern = pattern;

        switch (pattern) {
            case 'SHORT':
                await this._patternShort();
                break;
            case 'PULSE':
                await this._patternPulse();
                break;
            case 'LONG':
                await this._patternLong();
                break;
            case 'WAVE':
                await this._patternWave();
                break;
            default:
                break;
        }
    }

    stopPattern() {
        this.currentPattern = null;
        if (this.patternTimeout) {
            clearTimeout(this.patternTimeout);
            this.patternTimeout = null;
        }
        this.stopStrobe();
    }

    /**
     * Emergency stop – turn everything off immediately
     */
    emergencyStop() {
        this.stopPattern();
        this.stopStrobe();
        this.turnOff();
    }

    // --- Pattern implementations ---

    async _patternShort() {
        // Quick flash bursts: 3x short flashes
        for (let i = 0; i < 3; i++) {
            if (this.currentPattern !== 'SHORT') return;
            await this.flashOnce(80);
            await this._wait(120);
        }
    }

    async _patternPulse() {
        // Slow pulse: on 500ms, off 500ms, repeat
        const loop = async () => {
            if (this.currentPattern !== 'PULSE') return;
            await this.turnOn();
            this.patternTimeout = setTimeout(async () => {
                await this.turnOff();
                this.patternTimeout = setTimeout(() => loop(), 500);
            }, 500);
        };
        loop();
    }

    async _patternLong() {
        // Long sustained flash: 2 seconds on
        await this.turnOn();
        this.patternTimeout = setTimeout(() => {
            this.turnOff();
        }, 2000);
    }

    async _patternWave() {
        // Wave: gradually increasing/decreasing strobe
        const steps = [2, 4, 8, 12, 16, 12, 8, 4, 2];
        let i = 0;
        const stepDuration = 400;

        const nextStep = () => {
            if (this.currentPattern !== 'WAVE' || i >= steps.length) {
                this.stopStrobe();
                return;
            }
            this.startStrobe(steps[i]);
            i++;
            this.patternTimeout = setTimeout(nextStep, stepDuration);
        };
        nextStep();
    }

    _wait(ms) {
        return new Promise(r => { this.patternTimeout = setTimeout(r, ms); });
    }

    // --- Screen flash fallback ---

    _screenFlashOn() {
        let overlay = document.getElementById('flash-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'flash-overlay';
            overlay.className = 'flash-overlay';
            document.body.appendChild(overlay);
        }
        overlay.classList.add('active');
    }

    _screenFlashOff() {
        const overlay = document.getElementById('flash-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    /**
     * Get battery level (0-100) if available
     */
    async getBatteryLevel() {
        try {
            if ('getBattery' in navigator) {
                const battery = await navigator.getBattery();
                return Math.round(battery.level * 100);
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    /**
     * Clean up resources
     */
    dispose() {
        this.emergencyStop();
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
            this.track = null;
        }
    }
}

// Export as global
window.TorchController = TorchController;
