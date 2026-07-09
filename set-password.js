#!/usr/bin/env node

const { hashPassword } = require('./auth');
const { setSetting } = require('./db');

const password = process.argv[2];

if (!password) {
    console.error('Usage: node set-password.js <password>');
    process.exit(1);
}

try {
    const hash = hashPassword(password);
    setSetting('password_hash', hash);
    console.log('✓ Password set successfully');
} catch (error) {
    console.error('Error setting password:', error.message);
    process.exit(1);
}
