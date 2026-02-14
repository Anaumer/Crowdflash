// Camera & Recording Logic

const btnRecordMode = document.getElementById('btn-record-mode');
const recordOverlay = document.getElementById('record-overlay');
const btnCloseCamera = document.getElementById('btn-close-camera');
const btnCaptureAction = document.getElementById('btn-capture-action');
const recordInner = document.getElementById('record-inner');
const cameraPreview = document.getElementById('camera-preview');
const recordTimer = document.getElementById('record-timer');
const uploadStatus = document.getElementById('upload-status');

let stream = null;
let mediaRecorder = null;
let chunks = [];
let isRecording = false;
let startTime = 0;
let timerInterval = null;

if (btnRecordMode) {
    btnRecordMode.addEventListener('click', openCamera);
}

if (btnCloseCamera) {
    btnCloseCamera.addEventListener('click', closeCamera);
}

if (btnCaptureAction) {
    btnCaptureAction.addEventListener('click', toggleRecording);
}

async function openCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: true
        });
        cameraPreview.srcObject = stream;
        recordOverlay.style.display = 'flex';
        uploadStatus.textContent = '';
    } catch (err) {
        console.error('Camera Access Error:', err);
        alert('Could not access camera. Please allow permissions.');
    }
}

function closeCamera() {
    if (isRecording) {
        stopRecording();
    }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    recordOverlay.style.display = 'none';
}

function toggleRecording() {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
}

function startRecording() {
    if (!stream) return;

    chunks = [];
    try {
        // Prefer proper mime types
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
        mediaRecorder = new MediaRecorder(stream, { mimeType });
    } catch (e) {
        console.warn('Fallback to default MediaRecorder mime');
        mediaRecorder = new MediaRecorder(stream);
    }

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = uploadVideo;

    mediaRecorder.start();
    isRecording = true;

    // UI Updates
    recordInner.style.borderRadius = '4px';
    recordInner.style.transform = 'scale(0.5)';
    recordTimer.style.display = 'block';

    startTime = Date.now();
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

    mediaRecorder.stop();
    isRecording = false;

    // UI Updates
    recordInner.style.borderRadius = '50%';
    recordInner.style.transform = 'scale(1)';
    clearInterval(timerInterval);
}

function updateTimer() {
    const diff = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(diff / 60).toString().padStart(2, '0');
    const s = (diff % 60).toString().padStart(2, '0');
    recordTimer.textContent = `${m}:${s}`;
}

async function uploadVideo() {
    const blob = new Blob(chunks, { type: 'video/webm' });
    uploadStatus.textContent = 'Uploading...';
    btnCaptureAction.style.display = 'none'; // Prevent double record

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: blob,
            headers: {
                'X-Filename': `rec_${Date.now()}.webm`
            }
        });

        const data = await response.json();

        if (data.success) {
            uploadStatus.textContent = 'Sent! ✨';
            uploadStatus.style.color = '#4ade80';
            setTimeout(() => {
                closeCamera();
                btnCaptureAction.style.display = 'flex'; // Reset for next time if they open again
            }, 1500);
        } else {
            throw new Error('Server returned failure');
        }
    } catch (err) {
        console.error('Upload failed:', err);
        uploadStatus.textContent = 'Failed to upload.';
        uploadStatus.style.color = '#ef4444';
        btnCaptureAction.style.display = 'flex';
    }
}
