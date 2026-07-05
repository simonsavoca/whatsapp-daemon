/**
 * Migration one-shot : datas/whatsapp_messages.jsonl + whatsapp_last_read.txt -> whatsapp.db
 * Idempotent (INSERT OR IGNORE sur wa_id) — peut être relancée sans dupliquer.
 * Appelé automatiquement par daemon.js au démarrage si le JSONL existe.
 */
const fs = require('fs');
const path = require('path');
const { getDb, DATA_DIR } = require('./db');

const MESSAGES_FILE = path.join(DATA_DIR, 'whatsapp_messages.jsonl');
const LAST_READ_FILE = path.join(DATA_DIR, 'whatsapp_last_read.txt');

function migrate() {
    if (!fs.existsSync(MESSAGES_FILE)) return { migrated: 0 };

    const db = getDb();
    const lines = fs.readFileSync(MESSAGES_FILE, 'utf8').trim().split('\n').filter(Boolean);

    const insertMsg = db.prepare(`
        INSERT OR IGNORE INTO messages (wa_id, jid, chat_name, sender, message_type, text, raw_key, from_me, timestamp)
        VALUES (@wa_id, @jid, @chat_name, @sender, @message_type, @text, @raw_key, 0, @timestamp)
    `);
    const upsertChat = db.prepare(`
        INSERT INTO chats (jid, name, is_group, updated_at)
        VALUES (@jid, @name, @is_group, @updated_at)
        ON CONFLICT(jid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `);

    let migrated = 0;
    const run = db.transaction((entries) => {
        for (const entry of entries) {
            let parsed;
            try { parsed = JSON.parse(entry); } catch { continue; }
            if (!parsed.jid) continue;
            insertMsg.run({
                wa_id: parsed.key?.id || null,
                jid: parsed.jid,
                chat_name: parsed.from || null,
                sender: parsed.sender || null,
                message_type: 'text',
                text: parsed.text || '',
                raw_key: parsed.key ? JSON.stringify(parsed.key) : null,
                timestamp: parsed.t,
            });
            upsertChat.run({
                jid: parsed.jid,
                name: parsed.from || null,
                is_group: parsed.jid.endsWith('@g.us') ? 1 : 0,
                updated_at: parsed.t,
            });
            migrated++;
        }
    });
    run(lines);

    if (fs.existsSync(LAST_READ_FILE)) {
        const cursor = fs.readFileSync(LAST_READ_FILE, 'utf8').trim();
        if (cursor) {
            db.prepare('UPDATE messages SET read_at = ? WHERE timestamp <= ? AND read_at IS NULL')
                .run(cursor, cursor);
        }
    }

    return { migrated };
}

module.exports = { migrate };

if (require.main === module) {
    const result = migrate();
    console.log(`Migration terminée : ${result.migrated} message(s) importé(s).`);
}
