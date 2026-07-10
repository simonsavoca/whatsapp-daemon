/**
 * Daemon WhatsApp
 * Auth : session persistante via Baileys (scan QR unique)
 * Session stockée dans : data/whatsapp_auth/
 * Client WhatsApp pur : détient le socket Baileys + la base SQLite (data/whatsapp.db).
 * Toute interaction (lecture ET action) passe par l'API HTTP ci-dessous — aucun autre
 * process ne doit lire/écrire whatsapp.db directement.
 */
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    areJidsSameUser,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { getDb, getSetting } = require('./db');
const { migrate } = require('./migrate');
const {
    ensureBootstrapSecrets,
    verifyPassword,
    renewApiToken,
    createSessionCookie,
    verifySessionCookie,
    getSessionCookie,
    checkBearer,
} = require('./auth');

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'whatsapp_auth');
const WEB_DIR = path.join(__dirname, 'web');
const IPC_PORT = 3099;

const nameCache = {};
let currentSock = null;
let connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'open' | 'logged_out'
let lastUser = null;
let latestQr = null; // data URL PNG du dernier QR émis, null si connecté ou pas encore généré
let isResetting = false;

function messageTypeAndText(message) {
    if (!message) return { type: 'other', text: '' };
    if (message.conversation != null) return { type: 'text', text: message.conversation };
    if (message.extendedTextMessage) return { type: 'text', text: message.extendedTextMessage.text || '' };
    if (message.imageMessage) return { type: 'image', text: message.imageMessage.caption || '' };
    if (message.videoMessage) return { type: 'video', text: message.videoMessage.caption || '' };
    if (message.documentMessage) return { type: 'document', text: message.documentMessage.caption || message.documentMessage.fileName || '' };
    if (message.audioMessage) return { type: 'audio', text: '' };
    if (message.stickerMessage) return { type: 'sticker', text: '' };
    return { type: 'other', text: '' };
}

// Remplace les mentions brutes `@<numéro>` (ex. @258144915706059) par `@<nom>` en
// s'appuyant sur la table chats (annuaire jid→name). Non destructif : n'agit que sur
// la valeur renvoyée, jamais en base. Un id non résolu est laissé tel quel.
let mentionStmt = null;
function resolveMentions(db, text) {
    if (!text || !/@\d/.test(text)) return text;
    if (!mentionStmt) mentionStmt = db.prepare('SELECT name FROM chats WHERE jid LIKE ? LIMIT 1');
    const cache = new Map();
    return text.replace(/@(\d+)/g, (whole, userpart) => {
        if (!cache.has(userpart)) {
            const row = mentionStmt.get(`${userpart}@%`);
            cache.set(userpart, row?.name || null);
        }
        const name = cache.get(userpart);
        return name ? `@${name}` : whole;
    });
}

async function resolveName(sock, jid, pushName) {
    if (nameCache[jid]) return nameCache[jid];
    if (jid.endsWith('@g.us')) {
        try {
            const meta = await sock.groupMetadata(jid);
            nameCache[jid] = meta.subject;
        } catch {
            nameCache[jid] = jid;
        }
    } else {
        nameCache[jid] = pushName || jid.split('@')[0];
    }
    return nameCache[jid];
}

function upsertChat(db, jid, name) {
    if (!name) return;
    db.prepare(`
        INSERT INTO chats (jid, name, is_group, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(jid, name, jid.endsWith('@g.us') ? 1 : 0, new Date().toISOString());
}

// Utilisé par contacts.set, contacts.update ET messaging-history.set (rattrapage après coupure).
function applyContact(db, c) {
    const name = c.name || c.notify;
    if (name && c.id) {
        nameCache[c.id] = name;
        upsertChat(db, c.id, name);
    }
}

// Marque comme lus les messages d'un chat si son unreadCount est tombé à 0.
// Utilisé par chats.update ET messaging-history.set.
function markChatReadIfZero(db, markReadStmt, chat) {
    if (chat.id && chat.unreadCount === 0) {
        const now = new Date().toISOString();
        return markReadStmt.run(now, chat.id).changes;
    }
    return 0;
}

// Insère en base les messages reçus (temps réel via messages.upsert OU rattrapage via
// messaging-history.set après une coupure). Dédoublonné par wa_id (UNIQUE + INSERT OR IGNORE).
function insertMessages(sock, db, messages, { log = false } = {}) {
    if (!messages || !messages.length) return 0;
    const insert = db.prepare(`
        INSERT OR IGNORE INTO messages (wa_id, jid, chat_name, sender, message_type, text, raw_key, from_me, timestamp, read_at)
        VALUES (@wa_id, @jid, @chat_name, @sender, @message_type, @text, @raw_key, @from_me, @timestamp, @read_at)
    `);
    let inserted = 0;
    const run = db.transaction((msgs) => {
        for (const msg of msgs) {
            const from = msg.key.remoteJid;
            if (!from) continue;
            const { type: msgType, text } = messageTypeAndText(msg.message);
            const t = msg.messageTimestamp
                ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
                : new Date().toISOString();
            const name = nameCache[from] || msg.pushName || from.split('@')[0];
            if (from.endsWith('@g.us') && !nameCache[from]) {
                sock.groupMetadata(from)
                    .then(meta => { nameCache[from] = meta.subject; upsertChat(db, from, meta.subject); })
                    .catch(() => { nameCache[from] = from; });
            } else if (!from.endsWith('@g.us')) {
                upsertChat(db, from, name);
            }
            const sender = msg.pushName || msg.key.participant?.split('@')[0] || '';

            const info = insert.run({
                wa_id: msg.key.id || null,
                jid: from,
                chat_name: name,
                sender,
                message_type: msgType,
                text,
                raw_key: JSON.stringify(msg.key),
                from_me: msg.key.fromMe ? 1 : 0,
                timestamp: t,
                read_at: msg.key.fromMe ? t : null,
            });

            if (info.changes > 0) {
                inserted++;
                if (log && !msg.key.fromMe) {
                    console.log(`[${name}] ${msgType === 'text' ? text : `(${msgType}) ${text}`}`);
                }
            }
        }
    });
    run(messages);
    return inserted;
}

// ---------------------------------------------------------------------------
// API HTTP — seul point d'accès aux données/actions WhatsApp pour le reste du système
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

async function handleRecent(query, res) {
    const db = getDb();
    const limit = query.limit ? parseInt(query.limit, 10) : 20;
    const filter = query.filter;
    let rows;
    if (filter) {
        const kw = `%${filter.toLowerCase()}%`;
        rows = db.prepare(`
            SELECT * FROM messages
            WHERE LOWER(chat_name) LIKE ? OR LOWER(text) LIKE ?
            ORDER BY timestamp DESC LIMIT ?
        `).all(kw, kw, limit);
    } else {
        rows = db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?').all(limit);
    }
    for (const r of rows) r.text = resolveMentions(db, r.text);
    sendJson(res, 200, { messages: rows.reverse() });
}

async function handleUnread(res) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM messages WHERE read_at IS NULL ORDER BY timestamp ASC').all();
    for (const r of rows) r.text = resolveMentions(db, r.text);
    sendJson(res, 200, { messages: rows });
}

// Distingue un compte WhatsApp a resynchroniser (401, il faut re-appairer via /auth/reset)
// d'un daemon simplement pas encore connecte (503, transitoire — reessayer plus tard).
// A ne pas confondre avec le 401 { error: 'unauthorized' } d'un mauvais token API.
function requireConnected(res) {
    if (connectionState === 'logged_out') {
        sendJson(res, 401, {
            error: 'whatsapp_logged_out',
            message: 'Compte WhatsApp déconnecté — resynchronisation nécessaire (POST /auth/reset puis rescanner le QR code).',
        });
        return false;
    }
    if (!currentSock || connectionState !== 'open') {
        sendJson(res, 503, { error: 'daemon not connected' });
        return false;
    }
    return true;
}

async function handleMessagesRead(payload, res) {
    if (!requireConnected(res)) return;
    const db = getDb();
    let rows;
    if (payload.ids && payload.ids.length) {
        const placeholders = payload.ids.map(() => '?').join(',');
        rows = db.prepare(`SELECT * FROM messages WHERE id IN (${placeholders}) AND read_at IS NULL`).all(...payload.ids);
    } else {
        const upTo = payload.upTo || new Date().toISOString();
        rows = db.prepare('SELECT * FROM messages WHERE read_at IS NULL AND timestamp <= ?').all(upTo);
    }
    if (!rows.length) return sendJson(res, 200, { ok: true, count: 0 });

    const keys = rows.filter(r => r.raw_key).map(r => JSON.parse(r.raw_key));
    try {
        if (keys.length) await currentSock.readMessages(keys);
        const now = new Date().toISOString();
        const markRead = db.prepare('UPDATE messages SET read_at = ? WHERE id = ?');
        const run = db.transaction((ids) => { for (const id of ids) markRead.run(now, id); });
        run(rows.map(r => r.id));
        sendJson(res, 200, { ok: true, count: rows.length });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// Détecte si query ressemble à un numéro de téléphone plutôt qu'à un nom
// (espaces/tirets/parenthèses tolérés, +/00 en préfixe international).
function isPhoneQuery(query) {
    const cleaned = query.replace(/[\s\-().]/g, '');
    return /^\+?\d{7,15}$/.test(cleaned);
}

function normalizePhone(query) {
    let cleaned = query.replace(/[\s\-().]/g, '');
    if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
    if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
    return cleaned;
}

// Envoi à un numéro jamais contacté : on vérifie via onWhatsApp avant d'envoyer
// à l'aveugle, car WhatsApp peut renvoyer un JID différent du numéro brut (@lid).
async function handleSendToPhone(query, message, res) {
    const number = normalizePhone(query);
    try {
        const [result] = await currentSock.onWhatsApp(number);
        if (!result?.exists) {
            return sendJson(res, 404, { error: `Le numéro "${query}" n'est pas sur WhatsApp.` });
        }
        const jid = result.jid;
        await currentSock.sendMessage(jid, { text: message });
        const db = getDb();
        // Ne pas écraser le nom d'un contact qui a déjà écrit par le numéro brut
        const existing = db.prepare('SELECT name FROM chats WHERE jid = ?').get(jid);
        if (!existing) upsertChat(db, jid, number);
        sendJson(res, 200, { ok: true, msg: `Message envoyé à "${number}"`, jid });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

async function handleSend(payload, res) {
    if (!requireConnected(res)) return;
    const { query, message } = payload;
    if (!query || !message) return sendJson(res, 400, { error: 'query et message requis' });

    if (isPhoneQuery(query)) {
        return handleSendToPhone(query, message, res);
    }

    const db = getDb();
    const kw = `%${query.toLowerCase()}%`;
    const matches = db.prepare('SELECT jid, name, is_group FROM chats WHERE LOWER(name) LIKE ?').all(kw);

    if (!matches.length) {
        return sendJson(res, 404, { error: `Aucun contact/groupe correspondant à "${query}".` });
    }
    if (matches.length > 1) {
        return sendJson(res, 409, {
            error: `Plusieurs correspondances pour "${query}".`,
            matches: matches.map(m => ({ name: m.name, jid: m.jid, isGroup: !!m.is_group })),
        });
    }

    const [target] = matches;
    try {
        await currentSock.sendMessage(target.jid, { text: message });
        sendJson(res, 200, { ok: true, msg: `Message envoyé à "${target.name}"`, jid: target.jid });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// Archive/désarchive une conversation via l'app-state Baileys. chatModify exige le
// dernier message du chat (lastMessages) — reconstruit depuis raw_key comme /messages/read.
async function handleChatArchive(payload, res) {
    if (!requireConnected(res)) return;
    const { query } = payload;
    const archive = payload.archive !== false;
    if (!query) return sendJson(res, 400, { error: 'query requis' });

    const db = getDb();
    let matches;
    if (query.includes('@')) {
        // jid exact — permet de lever une ambiguïté 409 en repassant le jid retourné
        matches = db.prepare('SELECT jid, name, is_group FROM chats WHERE jid = ?').all(query);
    } else {
        const kw = `%${query.toLowerCase()}%`;
        matches = db.prepare('SELECT jid, name, is_group FROM chats WHERE LOWER(name) LIKE ?').all(kw);
    }

    if (!matches.length) {
        return sendJson(res, 404, { error: `Aucun contact/groupe correspondant à "${query}".` });
    }
    if (matches.length > 1) {
        return sendJson(res, 409, {
            error: `Plusieurs correspondances pour "${query}".`,
            matches: matches.map(m => ({ name: m.name, jid: m.jid, isGroup: !!m.is_group })),
        });
    }

    const [target] = matches;
    const row = db.prepare(
        'SELECT raw_key, timestamp FROM messages WHERE jid = ? AND raw_key IS NOT NULL ORDER BY timestamp DESC LIMIT 1'
    ).get(target.jid);
    if (!row) {
        return sendJson(res, 404, { error: `Aucun message en base pour "${target.name}" — impossible d'archiver.` });
    }

    const lastMessages = [{
        key: JSON.parse(row.raw_key),
        messageTimestamp: Math.floor(Date.parse(row.timestamp) / 1000),
    }];
    try {
        await currentSock.chatModify({ archive, lastMessages }, target.jid);
        sendJson(res, 200, {
            ok: true,
            msg: `Conversation "${target.name}" ${archive ? 'archivée' : 'désarchivée'}`,
            jid: target.jid,
        });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

async function handleJoinGroup(payload, res) {
    if (!requireConnected(res)) return;
    let inviteCode = null;
    try {
        inviteCode = payload.inviteLink.split('/').pop().split('?')[0];
        const jid = await currentSock.groupAcceptInvite(inviteCode);
        sendJson(res, 200, { ok: true, jid });
    } catch (e) {
        const msg = e.message || '';
        let errorType = 'unknown';
        if (msg === 'already-exists' && inviteCode) {
            try {
                const info = await currentSock.groupGetInviteInfo(inviteCode);
                const meta = await currentSock.groupMetadata(info.id);
                const selfJid = currentSock.user.id;
                const isMember = meta.participants.some(p => p.id === selfJid);
                errorType = isMember ? 'already-member' : 'pending-approval';
            } catch {
                errorType = 'already-exists';
            }
        }
        sendJson(res, 500, { error: msg, errorType });
    }
}

async function handleLogin(body, res) {
    const { password } = body;
    if (!password) return sendJson(res, 400, { error: 'password required' });

    const passwordHash = getSetting('password_hash');
    if (!passwordHash) return sendJson(res, 500, { error: 'password not configured' });

    try {
        if (!verifyPassword(password, passwordHash)) {
            return sendJson(res, 401, { error: 'unauthorized' });
        }
        const cookie = createSessionCookie();
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `sid=${cookie}; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end(JSON.stringify({ ok: true }));
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

async function handleLogout(res) {
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
}

async function handleRenewToken(res) {
    try {
        const token = renewApiToken();
        sendJson(res, 200, { token });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

async function handleAuthStatus(res) {
    let db = { connected: true, error: null };
    let count = null, unreadCount = null, chatsCount = null, activeChatsCount = null;
    try {
        const conn = getDb();
        count = conn.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
        unreadCount = conn.prepare('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL').get().n;
        // chatsCount inclut tous les contacts synchronisés (carnet d'adresses WhatsApp),
        // pas seulement ceux avec qui une conversation a réellement eu lieu — d'où activeChatsCount.
        chatsCount = conn.prepare('SELECT COUNT(*) AS n FROM chats').get().n;
        activeChatsCount = conn.prepare('SELECT COUNT(DISTINCT jid) AS n FROM messages').get().n;
    } catch (e) {
        db = { connected: false, error: e.message };
    }
    sendJson(res, 200, {
        connectionState,
        user: lastUser,
        messageCount: count,
        unreadCount,
        readCount: count != null && unreadCount != null ? count - unreadCount : null,
        chatsCount,
        activeChatsCount,
        apiToken: getSetting('api_token'),
        db,
    });
}

async function handleAuthQr(res) {
    sendJson(res, 200, { qr: latestQr, connectionState });
}

function resetDb() {
    const db = getDb();
    const run = db.transaction(() => {
        db.prepare('DELETE FROM messages').run();
        db.prepare('DELETE FROM chats').run();
    });
    run();
    for (const key of Object.keys(nameCache)) delete nameCache[key];
}

async function handleDbReset(res) {
    try {
        resetDb();
        sendJson(res, 200, { ok: true });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// Un reset d'auth relie un nouvel appareil, ce qui redéclenche une synchro complète
// (messaging-history.set) et re-remplirait la base avec l'ancien historique/contacts.
// On vide donc aussi messages/chats pour repartir sur une base cohérente avec la nouvelle session.
async function handleAuthReset(res) {
    if (isResetting) return sendJson(res, 409, { error: 'Reset déjà en cours.' });
    isResetting = true;
    try {
        if (currentSock) {
            // Détacher les listeners avant de fermer, pour que le handler 'close' existant
            // (qui rappelle connect() automatiquement) n'entre pas en course avec ce reset explicite.
            try { currentSock.ev.removeAllListeners(); } catch {}
            try { currentSock.end(new Error('manual reset')); } catch {}
            currentSock = null;
        }
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        resetDb();
        connectionState = 'connecting';
        lastUser = null;
        latestQr = null;
        await connect();
        sendJson(res, 200, { ok: true });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    } finally {
        isResetting = false;
    }
}

// ---------------------------------------------------------------------------
// Dashboard web — lecture seule (aucune action d'écriture depuis ces routes)
// ---------------------------------------------------------------------------

async function handleDbChats(query, res) {
    const db = getDb();
    const filter = query.filter;
    let rows;
    if (filter) {
        const kw = `%${filter.toLowerCase()}%`;
        rows = db.prepare('SELECT * FROM chats WHERE LOWER(name) LIKE ? ORDER BY updated_at DESC').all(kw);
    } else {
        rows = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all();
    }
    sendJson(res, 200, { chats: rows });
}

async function handleDbMessages(query, res) {
    const db = getDb();
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const filter = query.filter;
    let rows, total;
    if (filter) {
        const kw = `%${filter.toLowerCase()}%`;
        total = db.prepare(`
            SELECT COUNT(*) AS n FROM messages
            WHERE LOWER(chat_name) LIKE ? OR LOWER(text) LIKE ?
        `).get(kw, kw).n;
        rows = db.prepare(`
            SELECT * FROM messages
            WHERE LOWER(chat_name) LIKE ? OR LOWER(text) LIKE ?
            ORDER BY timestamp DESC LIMIT ? OFFSET ?
        `).all(kw, kw, limit, offset);
    } else {
        total = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
        rows = db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
    }
    for (const r of rows) r.text = resolveMentions(db, r.text);
    sendJson(res, 200, { messages: rows, total });
}

const STATIC_FILES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8', requireSession: true },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', requireSession: true },
    '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8', requireSession: true },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8', requireSession: true },
    '/login': { file: 'login.html', type: 'text/html; charset=utf-8', public: true },
};

function serveStatic(pathname, res, req) {
    const entry = STATIC_FILES[pathname];
    if (!entry) return false;

    if (!entry.public && entry.requireSession) {
        const sessionCookie = getSessionCookie(req);
        if (!sessionCookie || !verifySessionCookie(sessionCookie)) {
            res.writeHead(302, { Location: '/login' });
            res.end();
            return true;
        }
    }

    const filePath = path.join(WEB_DIR, entry.file);
    fs.readFile(filePath, (err, data) => {
        if (err) return sendJson(res, 500, { error: err.message });
        res.writeHead(200, { 'Content-Type': entry.type });
        res.end(data);
    });
    return true;
}

const ipcServer = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const pathname = url.pathname;

        // Routes publiques (pas d'authentification requise)
        if (req.method === 'GET' && pathname === '/login') {
            return serveStatic(pathname, res, req);
        }
        if (req.method === 'POST' && pathname === '/login') {
            const body = await readBody(req);
            return await handleLogin(body, res);
        }
        if (req.method === 'POST' && pathname === '/logout') {
            return await handleLogout(res);
        }

        // Routes d'API — Bearer token OU session
        if (req.method === 'GET' && pathname === '/messages/recent') {
            if (!checkBearer(req) && (!getSessionCookie(req) || !verifySessionCookie(getSessionCookie(req)))) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleRecent(Object.fromEntries(url.searchParams), res);
        }
        if (req.method === 'GET' && pathname === '/messages/unread') {
            if (!checkBearer(req) && (!getSessionCookie(req) || !verifySessionCookie(getSessionCookie(req)))) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleUnread(res);
        }
        if (req.method === 'POST' && pathname === '/messages/read') {
            if (!checkBearer(req) && (!getSessionCookie(req) || !verifySessionCookie(getSessionCookie(req)))) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            const body = await readBody(req);
            return await handleMessagesRead(body, res);
        }
        if (req.method === 'POST' && pathname === '/send') {
            if (!checkBearer(req)) return sendJson(res, 401, { error: 'unauthorized' });
            const body = await readBody(req);
            return await handleSend(body, res);
        }
        if (req.method === 'POST' && pathname === '/join-group') {
            if (!checkBearer(req)) return sendJson(res, 401, { error: 'unauthorized' });
            const body = await readBody(req);
            return await handleJoinGroup(body, res);
        }
        if (req.method === 'POST' && pathname === '/chat/archive') {
            if (!checkBearer(req)) return sendJson(res, 401, { error: 'unauthorized' });
            const body = await readBody(req);
            return await handleChatArchive(body, res);
        }
        if (req.method === 'GET' && pathname === '/auth/status') {
            if (!checkBearer(req) && (!getSessionCookie(req) || !verifySessionCookie(getSessionCookie(req)))) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleAuthStatus(res);
        }
        if (req.method === 'POST' && pathname === '/auth/reset') {
            if (!checkBearer(req) && (!getSessionCookie(req) || !verifySessionCookie(getSessionCookie(req)))) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleAuthReset(res);
        }

        // Routes du dashboard — session uniquement
        if (req.method === 'GET' && pathname === '/auth/qr') {
            const sessionCookie = getSessionCookie(req);
            if (!sessionCookie || !verifySessionCookie(sessionCookie)) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleAuthQr(res);
        }
        if (req.method === 'POST' && pathname === '/db/reset') {
            const sessionCookie = getSessionCookie(req);
            if (!sessionCookie || !verifySessionCookie(sessionCookie)) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleDbReset(res);
        }
        if (req.method === 'GET' && pathname === '/db/chats') {
            const sessionCookie = getSessionCookie(req);
            if (!sessionCookie || !verifySessionCookie(sessionCookie)) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleDbChats(Object.fromEntries(url.searchParams), res);
        }
        if (req.method === 'GET' && pathname === '/db/messages') {
            const sessionCookie = getSessionCookie(req);
            if (!sessionCookie || !verifySessionCookie(sessionCookie)) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleDbMessages(Object.fromEntries(url.searchParams), res);
        }
        if (req.method === 'POST' && pathname === '/auth/token/renew') {
            const sessionCookie = getSessionCookie(req);
            if (!sessionCookie || !verifySessionCookie(sessionCookie)) {
                return sendJson(res, 401, { error: 'unauthorized' });
            }
            return await handleRenewToken(res);
        }

        // Static files du dashboard
        if (req.method === 'GET' && serveStatic(pathname, res, req)) {
            return;
        }

        sendJson(res, 404, { error: 'not found' });
    } catch (e) {
        sendJson(res, 400, { error: e.message });
    }
});
ipcServer.on('error', e => {
    if (e.code !== 'EADDRINUSE') console.error('[IPC]', e.message);
});
ipcServer.listen(IPC_PORT, '127.0.0.1', () => {
    ensureBootstrapSecrets();
    console.log(`[IPC] HTTP server sur 127.0.0.1:${IPC_PORT}`);
});

async function connect() {
    connectionState = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: ['MAIA', 'Chrome', '1.0'],
        // Demande un rattrapage d'historique complet plutôt que le seul dernier message par chat.
        // Note : ce flag est envoyé au serveur lors du pairing (registration) — sur une session
        // déjà appairée, WhatsApp peut ne pas revenir en arrière pour autant. La ligne suivante
        // est le levier qui compte vraiment côté client :
        syncFullHistory: true,
        // Par défaut Baileys ignore silencieusement les paquets d'historique de type FULL
        // (cf. node_modules/@whiskeysockets/baileys/lib/Defaults/index.js — c'est probablement
        // la cause directe du "1 message par chat" observé). On les autorise tous ici pour l'essai.
        shouldSyncHistoryMessage: () => true,
    });
    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n=== SCANNE LE QR CODE AVEC WHATSAPP ===\n');
            qrcode.generate(qr, { small: true });
            try { latestQr = await QRCode.toDataURL(qr); } catch { latestQr = null; }
        }
        if (connection === 'open') {
            connectionState = 'open';
            latestQr = null;
            lastUser = { name: sock.user.name, id: sock.user.id };
            console.log(`WhatsApp connecte : ${sock.user.name} (${sock.user.id})`);
            const db = getDb();
            try {
                const groups = await sock.groupFetchAllParticipating();
                for (const [jid, meta] of Object.entries(groups)) {
                    nameCache[jid] = meta.subject;
                    upsertChat(db, jid, meta.subject);
                }
                console.log(`${Object.keys(groups).length} groupes chargés dans le cache`);
            } catch {}
        }
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                // Session revoquee (deconnexion depuis le telephone) : les creds dans
                // whatsapp_auth/ sont definitivement invalides, inutile de reessayer de se
                // connecter avec. On reste up (le serveur IPC continue de repondre) plutot
                // que de crasher — un restart PM2 rechargerait les memes creds mortes et
                // boucierait indefiniment. Il faut passer par /auth/reset (ou le bouton
                // "Reset" du dashboard) pour repartir avec un nouveau QR.
                connectionState = 'logged_out';
                currentSock = null;
                latestQr = null;
                console.error('Session WhatsApp revoquee — POST /auth/reset (ou bouton "Reset" du dashboard) pour re-appairer.');
                return;
            }
            connectionState = 'disconnected';
            connect();
        }
    });

    sock.ev.on('contacts.set', ({ contacts }) => {
        const db = getDb();
        for (const c of contacts) applyContact(db, c);
    });
    sock.ev.on('contacts.update', (updates) => {
        const db = getDb();
        for (const c of updates) applyContact(db, c);
    });

    sock.ev.on('chats.update', (updates) => {
        const db = getDb();
        const markRead = db.prepare(
            `UPDATE messages SET read_at = ? WHERE jid = ? AND read_at IS NULL`
        );
        for (const u of updates) {
            const changes = markChatReadIfZero(db, markRead, u);
            if (changes > 0) {
                console.log(`[SYNC] chats.update ${u.id} -> ${changes} message(s) marqué(s) lu(s)`);
            }
        }
    });

    // Rattrapage après coupure : Baileys délivre ici en bloc les chats/contacts/messages
    // manqués pendant que le daemon était arrêté (au lieu de messages.upsert au fil de l'eau).
    // Sans ce handler, tout ce qui arrive par ce canal était jusqu'ici silencieusement perdu.
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, syncType }) => {
        const db = getDb();

        for (const c of contacts || []) applyContact(db, c);

        const markRead = db.prepare(`UPDATE messages SET read_at = ? WHERE jid = ? AND read_at IS NULL`);
        let markedRead = 0;
        for (const chat of chats || []) {
            if (chat.name) upsertChat(db, chat.id, chat.name);
            markedRead += markChatReadIfZero(db, markRead, chat);
        }

        const inserted = insertMessages(sock, db, messages, { log: false });

        console.log(
            `[SYNC] messaging-history.set (type=${syncType ?? '?'}) : ` +
            `${chats?.length || 0} chat(s), ${contacts?.length || 0} contact(s), ` +
            `${inserted} message(s) rattrapé(s), ${markedRead} marqué(s) lu(s)` +
            `${isLatest ? ' [dernier lot]' : ''}`
        );
    });

    // Chats 1:1 : Baileys émet un statut READ par message quand il est lu sur un autre appareil lié.
    sock.ev.on('messages.update', (updates) => {
        const db = getDb();
        const markRead = db.prepare(`UPDATE messages SET read_at = ? WHERE wa_id = ? AND read_at IS NULL`);
        const now = new Date().toISOString();
        for (const { key, update } of updates) {
            if (key.id && update.status === 4 && !key.fromMe) {
                const info = markRead.run(now, key.id);
                if (info.changes > 0) {
                    console.log(`[SYNC] message ${key.id} marqué lu (autre appareil) — 1:1`);
                }
            }
        }
    });

    // Groupes : les accusés de lecture passent par message-receipt.update (un par participant),
    // il faut filtrer sur les accusés provenant de notre propre compte (autre appareil lié).
    sock.ev.on('message-receipt.update', (updates) => {
        const db = getDb();
        const markRead = db.prepare(`UPDATE messages SET read_at = ? WHERE wa_id = ? AND read_at IS NULL`);
        const me = state.creds.me;
        const selfJids = [me?.id, me?.lid, me?.phoneNumber].filter(Boolean);
        for (const { key, receipt } of updates) {
            if (!key.id || key.fromMe || !receipt.userJid || !receipt.readTimestamp) continue;
            if (selfJids.some(jid => areJidsSameUser(jid, receipt.userJid))) {
                const now = new Date(Number(receipt.readTimestamp) * 1000).toISOString();
                const info = markRead.run(now, key.id);
                if (info.changes > 0) {
                    console.log(`[SYNC] message ${key.id} marqué lu (autre appareil) — groupe`);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        const db = getDb();
        insertMessages(sock, db, messages, { log: true });
    });

    return sock;
}

module.exports = { connect };

if (require.main === module) {
    try {
        const { migrated } = migrate();
        if (migrated) console.log(`[MIGRATE] ${migrated} message(s) importé(s) depuis le JSONL.`);
    } catch (e) {
        console.error('[MIGRATE] erreur:', e.message);
    }
    connect().catch(console.error);
}
