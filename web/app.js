// Dashboard de contrôle du daemon WhatsApp — lecture seule, à deux exceptions près :
// le bouton de réinitialisation de l'authentification (POST /auth/reset)
// et le bouton de réinitialisation de la base de données (POST /db/reset).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --- Onglets --------------------------------------------------------------

$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// --- Helpers ---------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR');
  } catch { return iso; }
}

// --- Statut ------------------------------------------------------------

async function refreshStatus() {
  try {
    const s = await getJson('/auth/status');
    $('#st-state').textContent = s.connectionState;
    $('#st-user').textContent = s.user ? `${s.user.name} (${s.user.id})` : 'non connecté';
    $('#st-count').textContent = s.messageCount;
    $('#st-db').innerHTML = s.db?.connected
      ? '<span class="badge-read">connectée</span>'
      : `<span class="badge-unread">erreur${s.db?.error ? ' — ' + esc(s.db.error) : ''}</span>`;
    $('#st-updated').textContent = new Date().toLocaleTimeString('fr-FR');

    const dot = $('#live-dot');
    dot.className = 'dot ' + (s.connectionState === 'open' ? 'open' : s.connectionState === 'disconnected' ? 'disconnected' : '');

    await refreshAuthUi(s.connectionState);
  } catch (e) {
    $('#st-state').textContent = `Erreur : ${e.message}`;
    $('#live-dot').className = 'dot disconnected';
  }
}

// --- Authentification : QR code / reset --------------------------------
// Le bouton reset et le QR code ne sont jamais affichés en même temps :
// authentifié → bouton reset ; non authentifié → QR code (s'il est disponible).

let statusTimer = null;

function setPollInterval(ms) {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, ms);
}

async function refreshAuthUi(connectionState) {
  const qrBlock = $('#qr-block');
  const qrImg = $('#qr-img');
  const resetBtn = $('#btn-reset-auth');

  if (connectionState === 'open') {
    qrBlock.hidden = true;
    resetBtn.hidden = false;
    setPollInterval(5000);
    return;
  }

  resetBtn.hidden = true;
  try {
    const { qr } = await getJson('/auth/qr');
    if (qr) {
      qrImg.src = qr;
      qrBlock.hidden = false;
    } else {
      qrBlock.hidden = true;
    }
  } catch {
    qrBlock.hidden = true;
  }
}

$('#btn-reset-auth').addEventListener('click', async () => {
  if (!confirm("Réinitialiser l'authentification WhatsApp ? La session actuelle sera invalidée, il faudra scanner un nouveau QR code.")) return;
  const btn = $('#btn-reset-auth');
  btn.disabled = true;
  btn.hidden = true;
  try {
    const res = await fetch('/auth/reset', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setPollInterval(2000);
    refreshStatus();
  } catch (e) {
    alert(`Erreur lors du reset : ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-reset-db').addEventListener('click', async () => {
  if (!confirm("Réinitialiser la base de données ? Tous les messages et chats enregistrés seront définitivement supprimés. La session WhatsApp authentifiée n'est pas affectée.")) return;
  const btn = $('#btn-reset-db');
  btn.disabled = true;
  try {
    const res = await fetch('/db/reset', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    refreshStatus();
    refreshMessages();
    refreshChats();
    dbOffset = 0;
    refreshDbMessages();
  } catch (e) {
    alert(`Erreur lors du reset : ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// --- Messages reçus ------------------------------------------------------

function renderMessageRows(container, rows) {
  container.innerHTML = rows.map(m => `
    <tr>
      <td>${fmtDate(m.timestamp)}</td>
      <td>${esc(m.chat_name)}</td>
      <td>${esc(m.message_type)}</td>
      <td class="text-cell">${esc(m.text)}</td>
      <td>${m.read_at ? '<span class="badge-read">lu</span>' : '<span class="badge-unread">non lu</span>'}</td>
    </tr>
  `).join('') || '<tr><td colspan="5">Aucun message.</td></tr>';
}

async function refreshMessages() {
  const filter = $('#msg-filter').value.trim();
  const scope = $('#msg-scope').value;
  try {
    if (scope === 'unread') {
      const { messages } = await getJson('/messages/unread');
      const filtered = filter
        ? messages.filter(m => (m.chat_name || '').toLowerCase().includes(filter.toLowerCase()) || (m.text || '').toLowerCase().includes(filter.toLowerCase()))
        : messages;
      renderMessageRows($('#msg-rows'), filtered);
    } else {
      const qs = new URLSearchParams({ limit: '50', ...(filter ? { filter } : {}) });
      const { messages } = await getJson(`/messages/recent?${qs}`);
      renderMessageRows($('#msg-rows'), messages);
    }
  } catch (e) {
    $('#msg-rows').innerHTML = `<tr><td colspan="5">Erreur : ${esc(e.message)}</td></tr>`;
  }
}

$('#msg-refresh').addEventListener('click', refreshMessages);
$('#msg-filter').addEventListener('keydown', e => { if (e.key === 'Enter') refreshMessages(); });
$('#msg-scope').addEventListener('change', refreshMessages);

// --- Base de données : chats ------------------------------------------

async function refreshChats() {
  const filter = $('#chat-filter').value.trim();
  try {
    const qs = new URLSearchParams(filter ? { filter } : {});
    const { chats } = await getJson(`/db/chats?${qs}`);
    $('#chat-rows').innerHTML = chats.map(c => `
      <tr>
        <td>${esc(c.name)}</td>
        <td>${esc(c.jid)}</td>
        <td>${c.is_group ? 'oui' : 'non'}</td>
        <td>${fmtDate(c.updated_at)}</td>
      </tr>
    `).join('') || '<tr><td colspan="4">Aucun chat.</td></tr>';
  } catch (e) {
    $('#chat-rows').innerHTML = `<tr><td colspan="4">Erreur : ${esc(e.message)}</td></tr>`;
  }
}

$('#chat-refresh').addEventListener('click', refreshChats);
$('#chat-filter').addEventListener('keydown', e => { if (e.key === 'Enter') refreshChats(); });

// --- Base de données : messages (paginé) --------------------------------

const PAGE_SIZE = 50;
let dbOffset = 0;
let dbTotal = 0;

async function refreshDbMessages() {
  const filter = $('#db-filter').value.trim();
  try {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(dbOffset), ...(filter ? { filter } : {}) });
    const { messages, total } = await getJson(`/db/messages?${qs}`);
    dbTotal = total;
    $('#db-rows').innerHTML = messages.map(m => `
      <tr>
        <td>${m.id}</td>
        <td>${fmtDate(m.timestamp)}</td>
        <td>${esc(m.chat_name)}</td>
        <td>${esc(m.sender)}</td>
        <td>${esc(m.message_type)}</td>
        <td class="text-cell">${esc(m.text)}</td>
        <td>${m.read_at ? '<span class="badge-read">lu</span>' : '<span class="badge-unread">non lu</span>'}</td>
      </tr>
    `).join('') || '<tr><td colspan="7">Aucun message.</td></tr>';
    const page = Math.floor(dbOffset / PAGE_SIZE) + 1;
    const pages = Math.max(1, Math.ceil(dbTotal / PAGE_SIZE));
    $('#db-page-info').textContent = `Page ${page}/${pages} — ${dbTotal} message(s)`;
  } catch (e) {
    $('#db-rows').innerHTML = `<tr><td colspan="7">Erreur : ${esc(e.message)}</td></tr>`;
  }
}

$('#db-refresh').addEventListener('click', () => { dbOffset = 0; refreshDbMessages(); });
$('#db-filter').addEventListener('keydown', e => { if (e.key === 'Enter') { dbOffset = 0; refreshDbMessages(); } });
$('#db-prev').addEventListener('click', () => { dbOffset = Math.max(0, dbOffset - PAGE_SIZE); refreshDbMessages(); });
$('#db-next').addEventListener('click', () => { if (dbOffset + PAGE_SIZE < dbTotal) { dbOffset += PAGE_SIZE; refreshDbMessages(); } });

// --- Init + polling léger --------------------------------------------------

refreshStatus();
refreshMessages();
refreshChats();
refreshDbMessages();

setPollInterval(5000);
