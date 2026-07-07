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
const { getDb } = require('./db');
const { migrate } = require('./migrate');

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'whatsapp_auth');
const WEB_DIR = path.join(__dirname, 'web');
const IPC_PORT = 3099;

const nameCache = {};
let currentSock = null;
let connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'open'
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
    sendJson(res, 200, { messages: rows.reverse() });
}

async function handleUnread(res) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM messages WHERE read_at IS NULL ORDER BY timestamp ASC').all();
    sendJson(res, 200, { messages: rows });
}

async function handleMessagesRead(payload, res) {
    if (!currentSock) return sendJson(res, 503, { error: 'daemon not connected' });
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
    if (!currentSock) return sendJson(res, 503, { error: 'daemon not connected' });
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

async function handleJoinGroup(payload, res) {
    if (!currentSock) return sendJson(res, 503, { error: 'daemon not connected' });
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
    sendJson(res, 200, { messages: rows, total });
}

const STATIC_FILES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

function serveStatic(pathname, res) {
    const entry = STATIC_FILES[pathname];
    if (!entry) return false;
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
        if (req.method === 'GET' && url.pathname === '/messages/recent') {
            return await handleRecent(Object.fromEntries(url.searchParams), res);
        }
        if (req.method === 'GET' && url.pathname === '/messages/unread') {
            return await handleUnread(res);
        }
        if (req.method === 'GET' && url.pathname === '/auth/status') {
            return await handleAuthStatus(res);
        }
        if (req.method === 'GET' && url.pathname === '/auth/qr') {
            return await handleAuthQr(res);
        }
        if (req.method === 'POST' && url.pathname === '/auth/reset') {
            return await handleAuthReset(res);
        }
        if (req.method === 'POST' && url.pathname === '/db/reset') {
            return await handleDbReset(res);
        }
        if (req.method === 'GET' && url.pathname === '/db/chats') {
            return await handleDbChats(Object.fromEntries(url.searchParams), res);
        }
        if (req.method === 'GET' && url.pathname === '/db/messages') {
            return await handleDbMessages(Object.fromEntries(url.searchParams), res);
        }
        if (req.method === 'POST' && url.pathname === '/messages/read') {
            return await handleMessagesRead(await readBody(req), res);
        }
        if (req.method === 'POST' && url.pathname === '/send') {
            return await handleSend(await readBody(req), res);
        }
        if (req.method === 'POST' && url.pathname === '/join-group') {
            return await handleJoinGroup(await readBody(req), res);
        }
        if (req.method === 'GET' && serveStatic(url.pathname, res)) {
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
            connectionState = 'disconnected';
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.error('Session revoquee — supprimer whatsapp_auth/ et relancer.');
                process.exit(1);
            }
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
