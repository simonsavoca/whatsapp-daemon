const crypto = require('crypto');
const { getSetting, setSetting } = require('./db');

const SESSION_DURATION_DAYS = 30;
const SESSION_DURATION_MS = SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000;

function ensureBootstrapSecrets() {
    if (!getSetting('api_token')) {
        const token = crypto.randomBytes(32).toString('hex');
        setSetting('api_token', token);
        console.log('[AUTH] Generated new API token');
    }

    if (!getSetting('session_secret')) {
        const secret = crypto.randomBytes(32).toString('hex');
        setSetting('session_secret', secret);
        console.log('[AUTH] Generated new session secret');
    }

    if (!getSetting('password_hash')) {
        console.warn('[AUTH] ⚠️  No password set for dashboard. Run: node set-password.js <password>');
    }
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, storedHash) {
    const [saltHex, hashHex] = storedHash.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const hash = crypto.scryptSync(password, salt, 64);
    const providedHash = hash.toString('hex');
    return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(hashHex));
}

function renewApiToken() {
    const token = crypto.randomBytes(32).toString('hex');
    setSetting('api_token', token);
    return token;
}

function createSessionCookie() {
    const expiry = Date.now() + SESSION_DURATION_MS;
    const expiryStr = expiry.toString(36);
    const secret = getSetting('session_secret');
    const hmac = crypto.createHmac('sha256', secret).update(expiryStr).digest('hex');
    return `${expiryStr}.${hmac}`;
}

function verifySessionCookie(cookieValue) {
    if (!cookieValue) return false;
    const [expiryStr, hmacHex] = cookieValue.split('.');
    if (!expiryStr || !hmacHex) return false;

    const now = Date.now();
    try {
        const expiry = parseInt(expiryStr, 36);
        if (expiry < now) return false;
    } catch {
        return false;
    }

    const secret = getSetting('session_secret');
    const expectedHmac = crypto.createHmac('sha256', secret).update(expiryStr).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(hmacHex), Buffer.from(expectedHmac));
    } catch {
        return false;
    }
}

function getSessionCookie(req) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const match = cookieHeader.match(/sid=([^;]*)/);
    return match ? match[1] : null;
}

function checkBearer(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return false;
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (!match) return false;
    const providedToken = match[1];
    const storedToken = getSetting('api_token');
    try {
        return crypto.timingSafeEqual(Buffer.from(providedToken), Buffer.from(storedToken));
    } catch {
        return false;
    }
}

module.exports = {
    ensureBootstrapSecrets,
    hashPassword,
    verifyPassword,
    renewApiToken,
    createSessionCookie,
    verifySessionCookie,
    getSessionCookie,
    checkBearer,
    SESSION_DURATION_DAYS,
};
