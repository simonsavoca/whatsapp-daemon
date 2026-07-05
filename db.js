/**
 * Base SQLite du daemon WhatsApp — source de vérité unique.
 * Utilisé uniquement par daemon.js (aucun autre process ne doit lire/écrire ce fichier directement).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'whatsapp.db');

let db = null;

function getDb() {
    if (db) return db;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wa_id TEXT UNIQUE,
            jid TEXT NOT NULL,
            chat_name TEXT,
            sender TEXT,
            message_type TEXT,
            text TEXT,
            raw_key TEXT,
            from_me INTEGER DEFAULT 0,
            timestamp TEXT NOT NULL,
            read_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(jid);

        CREATE TABLE IF NOT EXISTS chats (
            jid TEXT PRIMARY KEY,
            name TEXT,
            is_group INTEGER,
            updated_at TEXT
        );
    `);
    return db;
}

module.exports = { getDb, DB_PATH, DATA_DIR };
