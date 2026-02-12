/**
 * CROWDFLASH - Deployment Configuration
 * 
 * In production (Netlify), change the BACKEND_URL to point to your
 * hosted Node.js WebSocket server (e.g., "wss://your-app.onrender.com").
 * 
 * If left empty or null, it will default to the current window location.
 */
window.CROWDFLASH_CONFIG = {
    // Example: "wss://crowdflash-backend.onrender.com"
    BACKEND_URL: "wss://crowdflash-production.up.railway.app"
};
