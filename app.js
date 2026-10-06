import { validateBadge, deleteBlocker, describe, plural, ROLE_SETS, SUB_SETS, CHANNEL_SETS, SLOT_OF_UPLOAD, UNLOCK_RANGE, SUB_MONTHS } from './rules.js?v=__V__';

/* ---------- config ---------- */
const CHANNEL = 'AlkatrazzJR';
const API = location.hostname === 'localhost' ? 'http://localhost:8791' : 'https://twitch-badge-chat-api.alkatrazzzzajr.workers.dev';

/* ---------- storage ---------- */
const store = {
  get(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota: works in-memory */ }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

/* ---------- constants ---------- */
const MAX_MESSAGES = 150;            // Twitch keeps roughly this many lines in the chat buffer
const MAX_MESSAGE_LEN = 500;         // Twitch chat message limit

// Twitch's preset name colors, in the order of the identity card.
const COLORS = ['#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50', '#9ACD32', '#FF4500',
  '#2E8B57', '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F'];

// Twitch global badge sets grouped the way the identity card offers them.
// Twitch shows at most 3 badges: role, one channel badge (sub / bits / gifts / drop), one chosen global badge.
const SLOTS = ['role', 'subBadge', 'otherBadge']; // profile keys, in chat display order

/* ---------- identity for uploads: a random secret kept in this browser (+ optional owner admin key) ---------- */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let browserKey = store.get('tbc.key', null);
if (!browserKey) { browserKey = b64url(crypto.getRandomValues(new Uint8Array(32))); store.set('tbc.key', browserKey); }

// The owner opens the site once as …/#admin=<key>; the key is kept in this browser and removed from the URL.
const adminFromUrl = new URLSearchParams(location.hash.slice(1)).get('admin');
if (adminFromUrl) { store.set('tbc.adminKey', adminFromUrl); history.replaceState(null, '', location.pathname + location.search); }
const adminKey = store.get('tbc.adminKey', null);
addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).get('admin')) location.reload();
});

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Key': browserKey };
  if (adminKey) headers['X-Admin-Key'] = adminKey;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body), cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

/* ---------- data ---------- */
let state = store.get('tbc.state', { categories: [], badges: [] }); // cached copy renders instantly, then refreshed
let me = { category: null, admin: false };
let twitch = store.get('tbc.twitch', []); // [{ set, versions: [{ id, title, desc, x1, x2, x4 }] }]

const twitchBadge = (set, v) => ({
  id: `tw:${set}:${v.id}`, kind: 'twitch', set, title: v.title, desc: v.desc, images: { x1: v.x1, x2: v.x2, x4: v.x4 },
});
const versionOrder = (a, b) => (Number(a.id) - Number(b.id)) || a.id.localeCompare(b.id, 'en', { numeric: true });
const twitchSets = (names) => names.flatMap((n) => twitch.find((s) => s.set === n)?.versions.slice().sort(versionOrder).map((v) => twitchBadge(n, v)) ?? []);
const twitchGlobal = () => {
  const taken = new Set([...ROLE_SETS, ...SUB_SETS, ...CHANNEL_SETS]);
  return twitch.filter((s) => !taken.has(s.set)).flatMap((s) => s.versions.slice().sort(versionOrder).map((v) => twitchBadge(s.set, v)));
};

async function loadTwitch() {
  try {
    twitch = await (await fetch(`${API}/twitch`)).json();
    if (!Array.isArray(twitch)) throw new Error('bad payload');
    store.set('tbc.twitch', twitch);
    renderIdentity();
  } catch { /* keep the cached copy */ }
}

async function refresh() {
  try {
    const [s, m] = await Promise.all([api('/state'), api('/me')]);
    $('#apiError').hidden = true;
    // periodic refreshes must not rebuild the open pickers (scroll, search) when nothing changed
    if (JSON.stringify([s, m]) === JSON.stringify([state, me])) return;
    state = s; me = m;
    store.set('tbc.state', state);
  } catch (err) {
    $('#apiError').hidden = false;
    $('#apiError').textContent = `Сервер значков недоступен: ${err.message}`;
  }
  renderAll();
}

/* ---------- badge helpers ---------- */
// Messages store this view so old lines keep the badge they were sent with.
const badgeView = (b) => ({ images: b.images, title: b.title, desc: describe(b) });
const bigSrc = (imgs) => imgs.x4 || imgs.x2 || imgs.x1;

function byId(id) {
  if (!id) return null;
  if (!id.startsWith('tw:')) return state.badges.find((b) => b.id === id);
  const [, set, version] = id.split(':');
  const v = twitch.find((s) => s.set === set)?.versions.find((x) => x.id === version);
  return v ? twitchBadge(set, v) : null;
}
const categoryName = (id) => state.categories.find((c) => c.id === id)?.name ?? '—';
const ownBadges = () => (me.category ? state.badges.filter((b) => b.categoryId === me.category.id) : []);

const currentBadges = () => SLOTS.map((k) => byId(profile[k])).filter(Boolean).map(badgeView);

function badgeImg(v) {
  const imgs = v.images;
  const img = el('img', { className: 'badge', src: imgs.x1 || imgs.x4, alt: v.title, width: 18, height: 18 });
  const set = [['x1', '1x'], ['x2', '2x'], ['x4', '4x']].filter(([k]) => imgs[k]);
  if (set.length > 1) img.srcset = set.map(([k, d]) => `${imgs[k]} ${d}`).join(', ');
  img.dataset.title = v.title;
  img.dataset.desc = v.desc || '';
  img.dataset.big = bigSrc(imgs);
  // Twitch's CDN lacks a few small sizes: fall back to the large image once
  img.onerror = () => { if (img.src !== img.dataset.big) { img.removeAttribute('srcset'); img.src = img.dataset.big; } else img.remove(); };
  return img;
}

/* ---------- state ---------- */
const profile = Object.assign(
  { nick: '', color: '#FF0000', role: null, subBadge: null, otherBadge: null },
  store.get('tbc.profile', {}),
);
// nick is unique per browser on the server; start with a random one like Twitch's anonymous viewers
if (!profile.nick || profile.nick === 'Viewer') profile.nick = `viewer${Math.floor(10000 + Math.random() * 90000)}`;
// v1 stored roles as plain names with home-made icons
if (profile.role && !profile.role.startsWith('tw:')) profile.role = `tw:${profile.role}:1`;
// v2 had a 4th slot; Twitch only has 3
if ('extraBadge' in profile) { profile.channelBadge ??= profile.extraBadge; delete profile.extraBadge; }
// v4 had channel + global slots; Twitch's slots are subscription + one other badge
if ('channelBadge' in profile || 'globalBadge' in profile) {
  const ch = profile.channelBadge;
  const isSub = ch && (/^tw:(subscriber|founder):/.test(ch) || state.badges.find((b) => b.id === ch)?.kind === 'sub');
  profile.subBadge ??= isSub ? ch : null;
  profile.otherBadge ??= (!isSub && ch) || profile.globalBadge || null;
  delete profile.channelBadge; delete profile.globalBadge;
}
let messages = [];        // shared chat, kept by the server
let chatAdmin = false;    // only the owner moderates the shared chat
store.del('tbc.messages'); // v1–v3 kept a per-browser chat
const settings = Object.assign({ timestamps: true }, store.get('tbc.settings', {}));
const saveProfile = () => store.set('tbc.profile', profile);

/* ---------- name color readability (Twitch lightens dark colors on the dark theme) ---------- */
function readable(hex) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = (r, g, b) => [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const bgLum = 0.0093; // #18181b
  for (let i = 0; i < 20 && (lum(r, g, b) + 0.05) / (bgLum + 0.05) < 3; i++) {
    [r, g, b] = [r, g, b].map((c) => c + (1 - c) * 0.12);
  }
  return '#' + [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}
/* ---------- chat rendering ---------- */
const scroller = $('#chatScroll');
const list = $('#messages');
const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
const fmtTime = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const trashIcon = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '16'); s.setAttribute('height', '16');
  s.innerHTML = '<path fill="currentColor" d="M9 2h6v2h6v2H3V4h6V2ZM5 8h2v12h10V8h2v14H5V8Zm4 2h2v8H9v-8Zm4 0h2v8h-2v-8Z"/>';
  return s;
};

function lineEl(m) {
  const line = el('div', { className: 'line' });
  line.dataset.id = m.id;
  line.append(el('span', { className: 'ts', textContent: fmtTime(m.t) }));
  if (chatAdmin) {
    line.append(el('button', { className: 'mod-btn', title: 'Удалить сообщение', ariaLabel: 'Удалить сообщение' }, trashIcon()));
  }
  for (const b of m.badges) line.append(badgeImg(b));
  line.append(
    el('span', { className: 'name', textContent: m.nick, style: `color:${readable(m.color)}` }),
    el('span', { textContent: ': ' }),
    el('span', { className: 'msg', textContent: m.text }),
  );
  return line;
}

function renderMessages() {
  list.replaceChildren(...messages.map(lineEl));
  scroller.scrollTop = scroller.scrollHeight;
}

function appendLine(node) {
  const stick = atBottom();
  list.append(node);
  while (list.children.length > MAX_MESSAGES) list.firstElementChild.remove();
  if (stick) scroller.scrollTop = scroller.scrollHeight; else $('#moreBtn').hidden = false;
}

// local-only notices (errors, "chat cleared"), styled like Twitch system lines
const notice = (text) => appendLine(el('div', { className: 'line notice', textContent: text }));

/* ---------- shared chat connection ---------- */
let ws = null;
let retry = 0;
const wsSend = (msg) => {
  if (ws?.readyState !== WebSocket.OPEN) { notice('Нет соединения с чатом, переподключаемся…'); return false; }
  ws.send(JSON.stringify(msg));
  return true;
};
const sendProfile = () => wsSend({ type: 'profile', nick: profile.nick, color: profile.color });

function connect() {
  ws = new WebSocket(API.replace(/^http/, 'ws') + '/chat');
  ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ type: 'hello', key: browserKey, adminKey })); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      $('#chatStatus').hidden = true;
      chatAdmin = msg.admin;
      messages = msg.messages;
      renderMessages();
      renderSettings();
      if (msg.me) applyServerProfile(msg.me); else sendProfile();
    } else if (msg.type === 'msg') {
      messages.push(msg.m);
      if (messages.length > MAX_MESSAGES) messages.shift();
      appendLine(lineEl(msg.m));
    } else if (msg.type === 'delete') {
      messages = messages.filter((m) => m.id !== msg.id);
      list.querySelector(`.line[data-id="${CSS.escape(msg.id)}"]`)?.remove();
    } else if (msg.type === 'clear') {
      messages = [];
      list.replaceChildren();
      notice('Чат был очищен модератором');
    } else if (msg.type === 'profile') {
      if (!msg.error) applyServerProfile(msg.me);
      else {
        $('#nickError').textContent = msg.error;
        $('#nickError').hidden = false;
        // keep posting under the last accepted nick / color
        if (registered) { profile.nick = registered.nick; profile.color = registered.color; saveProfile(); renderPreview(); }
      }
    } else if (msg.type === 'error') notice(msg.error);
  };
  ws.onclose = () => {
    $('#chatStatus').hidden = false;
    setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
  };
}

let registered = null;
function applyServerProfile(me) {
  registered = me;
  $('#nickError').hidden = true;
  profile.nick = me.nick;
  profile.color = me.color;
  saveProfile();
  if (document.activeElement !== $('#nickInput')) $('#nickInput').value = me.nick;
  $('#customColor').value = me.color.toLowerCase();
  renderPreview();
}

/* ---------- viewer card (click on a nickname) ---------- */
const viewerCard = $('#viewerCard');
function openViewerCard(m, anchor) {
  // Twitch lists every badge the user has; the closest we know is every badge they used in visible messages
  const seen = new Map();
  for (const x of messages) {
    if (x.nick !== m.nick) continue;
    for (const b of x.badges) seen.set(bigSrc(b.images), b);
  }
  $('#vcAvatar').textContent = m.nick.slice(0, 1).toUpperCase();
  $('#vcAvatar').style.background = m.color;
  viewerCard.style.setProperty('--vc-banner', m.color);
  $('#vcName').textContent = m.nick;
  $('#vcBadges').replaceChildren(...[...seen.values()].map((b) => {
    const img = el('img', { src: bigSrc(b.images), alt: b.title });
    Object.assign(img.dataset, { title: b.title, desc: b.desc || '', big: bigSrc(b.images) });
    return el('div', { className: 'vc-tile' }, img);
  }));
  $('#vcEmpty').hidden = seen.size > 0;
  const count = messages.filter((x) => x.nick === m.nick).length;
  $('#vcFooter').textContent = `Сообщений в чате: ${count} · последнее в ${fmtTime(Math.max(...messages.filter((x) => x.nick === m.nick).map((x) => x.t)))}`;
  const wasHidden = viewerCard.hidden;
  viewerCard.hidden = false;
  if (wasHidden) { // a moved card stays where the user dragged it, like on Twitch
    const chat = $('.chat').getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    placeCard(chat.left + (chat.width - viewerCard.offsetWidth) / 2, r.bottom + 4);
  }
}

function placeCard(x, y) {
  const maxX = innerWidth - viewerCard.offsetWidth - 4, maxY = innerHeight - viewerCard.offsetHeight - 4;
  viewerCard.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
  viewerCard.style.top = Math.max(4, Math.min(y, maxY)) + 'px';
}

$('#vcDrag').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  const start = viewerCard.getBoundingClientRect();
  const dx = e.clientX - start.left, dy = e.clientY - start.top;
  viewerCard.classList.add('dragging');
  $('#vcDrag').setPointerCapture(e.pointerId);
  const move = (ev) => placeCard(ev.clientX - dx, ev.clientY - dy);
  const stop = () => {
    viewerCard.classList.remove('dragging');
    $('#vcDrag').removeEventListener('pointermove', move);
  };
  $('#vcDrag').addEventListener('pointermove', move);
  $('#vcDrag').addEventListener('pointerup', stop, { once: true });
  $('#vcDrag').addEventListener('pointercancel', stop, { once: true });
});
addEventListener('resize', () => { if (!viewerCard.hidden) placeCard(viewerCard.offsetLeft, viewerCard.offsetTop); });
$('#vcClose').onclick = () => { viewerCard.hidden = true; };

list.addEventListener('click', (e) => {
  const name = e.target.closest('.name');
  if (name) {
    const m = messages.find((x) => x.id === name.closest('.line')?.dataset.id);
    if (m) openViewerCard(m, name);
    return;
  }
  const btn = e.target.closest('.mod-btn');
  if (!btn) return;
  wsSend({ type: 'delete', id: btn.closest('.line').dataset.id }); // removed when the server broadcasts it
});

scroller.addEventListener('scroll', () => { $('#moreBtn').hidden = atBottom(); });
$('#moreBtn').onclick = () => { scroller.scrollTop = scroller.scrollHeight; };

/* ---------- input ---------- */
const input = $('#msgInput');
const counter = $('#counter');
function syncInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  const left = MAX_MESSAGE_LEN - input.value.length;
  counter.textContent = left < 100 ? String(left) : '';
  counter.classList.toggle('over', left <= 0);
}
input.addEventListener('input', syncInput);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chatForm').requestSubmit(); }
});
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  const sent = wsSend({
    type: 'send', text: text.slice(0, MAX_MESSAGE_LEN),
    badges: { role: profile.role, sub: profile.subBadge, other: profile.otherBadge },
  });
  if (!sent) return;
  input.value = '';
  syncInput();
  input.focus();
});
/* ---------- popovers ---------- */
function togglePopover(id, force) {
  for (const p of document.querySelectorAll('.popover')) p.hidden = p.id === id ? !(force ?? p.hidden) : true;
}
$('#identityBtn').onclick = () => togglePopover('identity');
$('#usersBtn').onclick = () => togglePopover('identity');
$('#settingsBtn').onclick = () => togglePopover('settings');
$('#openIdentity2').onclick = () => togglePopover('identity', true);
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => togglePopover(b.dataset.close, false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { togglePopover(null); viewerCard.hidden = true; } });
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.popover, #identityBtn, #settingsBtn, #usersBtn')) togglePopover(null);
});
$('#collapseBtn').onclick = () => $('.chat').classList.toggle('collapsed');

const tsToggle = $('#tsToggle');
tsToggle.checked = settings.timestamps;
const applyTs = () => list.classList.toggle('hide-ts', !settings.timestamps);
tsToggle.onchange = () => { settings.timestamps = tsToggle.checked; store.set('tbc.settings', settings); applyTs(); };
$('#clearChat').onclick = () => { if (chatAdmin) wsSend({ type: 'clear' }); togglePopover(null); };
// Moderation entries exist only for the owner.
function renderSettings() { $('#modSection').hidden = !chatAdmin; renderPreview(); }
const renderMenuCategory = () => { $('#menuCategory').textContent = me.category?.name ?? 'не создана'; };

/* ---------- tooltip ---------- */
const tooltip = $('#tooltip');
document.addEventListener('pointerover', (e) => {
  const t = e.target.closest('img[data-title]');
  if (!t) { tooltip.hidden = true; return; }
  tooltip.replaceChildren(el('img', { src: t.dataset.big, alt: '' }), t.dataset.title,
    t.dataset.desc ? el('small', { textContent: t.dataset.desc }) : null);
  tooltip.hidden = false;
  const r = t.getBoundingClientRect();
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  tooltip.style.left = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2)) + 'px';
  tooltip.style.top = (r.top - h - 6 < 4 ? r.bottom + 6 : r.top - h - 6) + 'px';
});

/* ---------- identity card ---------- */
function badgeTile(b, key) {
  const v = badgeView(b);
  const btn = el('button', { type: 'button', className: 'badge-opt', title: v.title, ariaLabel: v.title });
  btn.dataset.id = b.id;
  btn.dataset.slot = key;
  btn.dataset.search = `${v.title} ${b.set ?? ''}`.toLowerCase();
  btn.setAttribute('aria-pressed', String(profile[key] === b.id));
  const img = el('img', { src: b.images.x2 || bigSrc(b.images), alt: '', loading: 'lazy', width: 28, height: 28 });
  if (b.images.x4) img.srcset = `${b.images.x2 || b.images.x4} 1x, ${b.images.x4} 2x`;
  Object.assign(img.dataset, { title: v.title, desc: v.desc, big: bigSrc(b.images) });
  btn.append(img);
  btn.onclick = () => pick(key, b.id);
  return btn;
}

function noneTile(key, label) {
  const btn = el('button', { type: 'button', className: 'badge-opt none', title: label, ariaLabel: label });
  btn.dataset.id = '';
  btn.dataset.slot = key;
  btn.setAttribute('aria-pressed', String(!profile[key]));
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A8 8 0 0 1 4 12Zm3.1 6.3L18.3 7.1A8 8 0 0 1 7.1 18.3Z" clip-rule="evenodd"/></svg>';
  btn.onclick = () => pick(key, null);
  return btn;
}

// groups: [{ name, badges }] — rendered as one tile grid per group, empty groups skipped
function renderPicker(container, key, groups, noneLabel) {
  const filled = groups.filter((g) => g.badges.length);
  const none = noneTile(key, noneLabel);
  if (!filled.length) { container.replaceChildren(el('div', { className: 'badge-grid' }, none)); return; }
  // the "no badge" tile leads the first grid, like on Twitch
  container.replaceChildren(...filled.map((g, i) => el('div', { className: 'badge-group' },
    g.name ? el('div', { className: 'group-name', textContent: g.name }) : null,
    el('div', { className: 'badge-grid' }, ...(i === 0 ? [none] : []), ...g.badges.map((b) => badgeTile(b, key))))));
}

const KIND_ORDER = { sub: 0, drop: 1, global: 2 };
const slotOf = (b) => (SLOT_OF_UPLOAD[b.kind] === 'sub' ? 'subBadge' : 'otherBadge');

// Each uploader category is its own section right under the role picker.
function renderCategories() {
  $('#categoryGrids').replaceChildren(...state.categories.map((cat) => {
    const badges = state.badges.filter((b) => b.categoryId === cat.id)
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.months ?? 0) - (b.months ?? 0));
    if (!badges.length) return null;
    return el('section', { className: 'cat-section' },
      el('h3', { textContent: cat.name }),
      el('div', { className: 'badge-grid' }, ...badges.map((b) => badgeTile(b, slotOf(b)))));
  }).filter(Boolean));
}

function pick(key, value) {
  profile[key] = value;
  saveProfile();
  if (key === 'color') sendProfile();
  for (const btn of document.querySelectorAll(`.badge-opt[data-slot="${key}"]`)) {
    btn.setAttribute('aria-pressed', String(btn.dataset.id === (value ?? '')));
  }
  renderPreview();
}

function renderPreview() {
  const badges = currentBadges();
  $('#preview').replaceChildren(...badges.map(badgeImg),
    el('span', { className: 'name', textContent: profile.nick, style: `color:${readable(profile.color)}` }));
  // Twitch's input shows a single badge here (ChatBadgeCarousel): the first one, role > channel > global
  $('#identityBtn').replaceChildren(...badges.slice(0, 1).map(badgeImg));
  if (!badges.length) $('#identityBtn').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" fill-rule="evenodd" d="M6 8a6 6 0 1 1 12 0A6 6 0 0 1 6 8Zm6 4a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm-5 4a4 4 0 0 0-4 4v2h2v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2h2v-2a4 4 0 0 0-4-4H7Z" clip-rule="evenodd"/></svg>';
  $('#modTools').hidden = !chatAdmin;
  $('#settingsBadges').replaceChildren(...badges.map(badgeImg));
  for (const b of document.querySelectorAll('.color-opt')) b.setAttribute('aria-pressed', String(profile.color.toUpperCase() === b.title));
}

function renderIdentity() {
  // drop references to badges that no longer exist (only once Twitch data is known)
  for (const k of SLOTS) {
    if (profile[k] && !byId(profile[k]) && (twitch.length || !profile[k].startsWith('tw:'))) { profile[k] = null; saveProfile(); }
  }
  renderPicker($('#roleGrid'), 'role', [{ badges: twitchSets(ROLE_SETS) }], 'Зритель');
  renderCategories();
  renderPicker($('#channelGrid'), 'subBadge', [
    { name: 'Twitch (по умолчанию)', badges: twitchSets(SUB_SETS) },
  ], 'Без значка');
  renderPicker($('#globalGrid'), 'otherBadge', [
    { name: 'Bits, подарки, прогнозы', badges: twitchSets(CHANNEL_SETS) },
    { name: 'Общие значки Twitch', badges: twitchGlobal() },
  ], 'Без значка');
  filterGlobal();

  $('#colorGrid').replaceChildren(...COLORS.map((c) => {
    const b = el('button', { type: 'button', className: 'color-opt', title: c, ariaLabel: `Цвет ${c}`, style: `background:${c}` });
    b.onclick = () => { pick('color', c); $('#customColor').value = c.toLowerCase(); };
    return b;
  }));
  $('#customColor').value = profile.color.toLowerCase();
  const nick = $('#nickInput');
  if (document.activeElement !== nick) nick.value = profile.nick;
  renderPreview();
}

function filterGlobal() {
  const q = $('#globalSearch').value.trim().toLowerCase();
  for (const btn of $('#globalGrid').querySelectorAll('.badge-opt[data-search]')) btn.hidden = Boolean(q) && !btn.dataset.search.includes(q);
  for (const g of $('#globalGrid').querySelectorAll('.badge-group')) g.hidden = !g.querySelector('.badge-opt:not([hidden])');
}
$('#globalSearch').addEventListener('input', filterGlobal);

let nickTimer;
$('#nickInput').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  profile.nick = v;
  renderPreview();
  clearTimeout(nickTimer);
  nickTimer = setTimeout(sendProfile, 600); // the server keeps the previous nick if this one is taken
});
$('#nickInput').addEventListener('blur', (e) => { e.target.value = profile.nick; });
$('#customColor').addEventListener('input', (e) => pick('color', e.target.value.toUpperCase()));

function renderAll() {
  renderIdentity();
  renderManager();
  renderMenuCategory();
}

/* ---------- badge manager dialog ---------- */
const dialog = $('#admin');
const status = (text, isErr = false) => { const s = $('#adminStatus'); s.textContent = text; s.classList.toggle('err', isErr); };

async function run(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { status(err.message, true); } finally { btn.disabled = false; }
}

function confirmClick(btn, label, action) {
  btn.onclick = () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Точно?';
      setTimeout(() => { btn.dataset.armed = ''; btn.textContent = label; }, 3000);
      return;
    }
    run(btn, action);
  };
}

function renderManager() {
  $('#adminBadge').hidden = !me.admin;
  $('#noCategory').hidden = Boolean(me.category);
  $('#hasCategory').hidden = !me.category;
  if (me.category) {
    $('#myCategoryName').textContent = me.category.name;
    if (document.activeElement !== $('#categoryInput')) $('#categoryInput').value = me.category.name;
  } else if (!$('#categoryInput').value) $('#categoryInput').value = profile.nick;

  const events = new Set(ownBadges().filter((b) => b.kind === 'drop').map((b) => b.event.name));
  $('#eventList').replaceChildren(...[...events].map((value) => el('option', { value })));

  const box = $('#badgeList');
  const cats = [...state.categories].sort((a, b) => (b.id === me.category?.id) - (a.id === me.category?.id));
  box.replaceChildren(...(cats.length ? cats.map((cat) => {
    const mine = cat.id === me.category?.id;
    const canEdit = mine || me.admin;
    const badges = state.badges.filter((b) => b.categoryId === cat.id);
    const head = el('div', { className: 'cat-head' });
    head.dataset.name = cat.name;
    if (canEdit) {
      const nameInput = el('input', { className: 'field', value: cat.name, maxLength: 25, minLength: 2, ariaLabel: 'Название категории' });
      const save = el('button', { className: 'btn', textContent: 'Переименовать' });
      save.onclick = () => run(save, async () => {
        await api(`/categories/${cat.id}`, { method: 'PUT', body: { name: nameInput.value } });
        await refresh();
        status(`Категория переименована в «${nameInput.value.trim()}».`);
      });
      head.append(nameInput, save);
    } else head.append(el('b', { textContent: cat.name }));
    head.append(el('span', { className: 'muted', textContent: `${mine ? 'моя · ' : ''}${badges.length} шт.` }));
    if (canEdit) {
      const del = el('button', { className: 'btn danger', textContent: 'Удалить категорию' });
      confirmClick(del, 'Удалить категорию', async () => {
        await api(`/categories/${cat.id}`, { method: 'DELETE' });
        await refresh();
        status(`Категория «${cat.name}» удалена.`);
      });
      head.append(del);
    }
    return el('div', { className: 'cat' }, head, ...badges.map((b) => {
      const v = badgeView(b);
      const row = el('div', { className: 'badge-item' },
        el('img', { src: bigSrc(v.images), alt: '' }),
        el('div', { className: 'info' }, el('b', { textContent: v.title }), el('span', { textContent: v.desc })));
      if (canEdit) {
        const del = el('button', { className: 'btn danger', textContent: 'Удалить' });
        confirmClick(del, 'Удалить', async () => {
          const blocker = deleteBlocker(b, badges);
          if (blocker) throw new Error(blocker);
          await api(`/badges/${b.id}`, { method: 'DELETE' });
          await refresh();
          status(`Значок «${b.title}» удалён.`);
        });
        row.append(del);
      }
      return row;
    }));
  }) : [el('span', { className: 'empty', textContent: 'Значков пока нет' })]));
}

$('#openAdmin').onclick = () => {
  togglePopover(null); status('');
  if (!me.category) $('#categoryInput').value = profile.nick;
  renderManager(); dialog.showModal(); refresh();
};
$('[data-close-dialog]').onclick = () => dialog.close();
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

$('#categoryForm').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, async () => {
    me = await api('/me', { method: 'PUT', body: { name: $('#categoryInput').value } });
    await refresh();
    status(`Категория «${me.category.name}» сохранена.`);
  });
});

// Moving rights to another browser = copying the key there.
$('#copyKey').onclick = async () => {
  try { await navigator.clipboard.writeText(browserKey); status('Ключ скопирован. Вставьте его на другом устройстве.'); } catch { status(browserKey); }
};
$('#keyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('#keyInput').value.trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) { status('Неверный ключ', true); return; }
  browserKey = key;
  store.set('tbc.key', key);
  $('#keyInput').value = '';
  status('Ключ применён.');
  refresh();
});

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.upload').forEach((f) => { f.hidden = f.dataset.kind !== t.dataset.tab; });
  };
});

/* ---------- upload forms ---------- */
const dropForm = $('#form-drop');
function fillAmounts() {
  const type = dropForm.elements.unlock.value;
  $('.top', dropForm).hidden = type !== 'top';
  $('.amount', dropForm).hidden = type === 'top';
  const amount = dropForm.elements.amount;
  amount.required = type !== 'top';
  if (type === 'top') return;
  const [min, max] = UNLOCK_RANGE[type];
  Object.assign(amount, { min, max, value: Math.min(Math.max(Number(amount.value) || min, min), max) });
  $('#amountLabel').textContent = type === 'watch' ? `Часов просмотра (${min}–${max})` : `Подписок или подарков (${min}–${max})`;
}
const localDT = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function resetDropForm() {
  fillAmounts();
  const start = new Date();
  start.setHours(start.getHours() + 1, 0, 0, 0);
  dropForm.elements.start.value = localDT(start);
  dropForm.elements.end.value = localDT(new Date(start.getTime() + 7 * 86400000));
}
dropForm.elements.unlock.addEventListener('change', fillAmounts);
// all badges of one event share its dates: picking an existing event fills them in
dropForm.elements.event.addEventListener('input', () => {
  const name = dropForm.elements.event.value.trim().toLowerCase();
  const ev = ownBadges().find((b) => b.kind === 'drop' && b.event.name.toLowerCase() === name);
  if (ev) { dropForm.elements.start.value = ev.event.start; dropForm.elements.end.value = ev.event.end; }
});
resetDropForm();

$('#form-sub').elements.months.replaceChildren(...SUB_MONTHS.map((m) => el('option', { value: m, textContent: `${m} мес.` })));

const fileBytes = async (input) => (input.files[0] ? new Uint8Array(await input.files[0].arrayBuffer()) : null);

async function readForm(form) {
  const f = form.elements;
  const kind = form.dataset.kind;
  const images = {};
  const sources = { drop: { x4: f.file }, sub: { x1: f.a18, x2: f.a36, x4: f.a72 }, global: { x4: f.file } }[kind];
  for (const [k, input] of Object.entries(sources)) { const b = await fileBytes(input); if (b) images[k] = b; }
  if (kind === 'drop') {
    const type = f.unlock.value;
    return {
      kind, title: f.title.value, images,
      event: { name: f.event.value, start: f.start.value, end: f.end.value },
      unlock: { type, amount: Number(type === 'top' ? f.top.value : f.amount.value) },
    };
  }
  if (kind === 'sub') return { kind, months: Number(f.months.value), images };
  return { kind, title: f.title.value, desc: f.desc.value, images };
}

const dataUrl = (bytes) => `data:image/png;base64,${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))}`;

function renderCheck(form, result, images) {
  const ul = el('ul');
  for (const i of result.items) ul.append(el('li', { className: i.level, textContent: (i.level === 'ok' ? '✓ ' : i.level === 'err' ? '✕ ' : '! ') + i.text }));
  const prev = el('div', { className: 'previews' });
  for (const bytes of Object.values(images)) {
    const src = dataUrl(bytes);
    // how it looks at chat size (18px), 2x and tooltip size
    prev.append(el('img', { src, width: 18, height: 18, alt: '18px' }), el('img', { src, width: 36, height: 36, alt: '36px' }), el('img', { src, width: 72, height: 72, alt: '72px' }));
  }
  $('.check', form).replaceChildren(ul, prev.children.length ? prev : '');
}

for (const form of document.querySelectorAll('.upload')) {
  const check = async (requireImages) => {
    const input = await readForm(form);
    const result = validateBadge(input, ownBadges(), { requireImages });
    renderCheck(form, result, input.images);
    return { input, result };
  };
  form.addEventListener('change', () => check(false));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      if (!me.category) throw new Error('Сначала создайте свою категорию');
      const { input, result } = await check(true);
      if (result.failed) throw new Error('Исправьте ошибки выше');
      status('Загрузка…');
      const images = Object.fromEntries(Object.entries(input.images).map(([k, b]) => [k, dataUrl(b).split(',')[1]]));
      const badge = await api('/badges', { method: 'POST', body: { ...input, images } });
      form.reset();
      if (form === dropForm) resetDropForm();
      $('.check', form).replaceChildren();
      await refresh();
      status(`Значок «${badge.title}» добавлен.`);
    });
  });
}

/* ---------- bulk import: PNG files or a ZIP archive ---------- */
// Minimal ZIP reader (stored / deflate entries) on top of the browser's DecompressionStream.
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Не ZIP-архив');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('Повреждённый ZIP');
    const method = dv.getUint16(off + 10, true), size = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), commentLen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + size);
    if (size > 2 * 1024 * 1024) { files.push({ name, error: 'файл слишком большой' }); continue; }
    if (method === 0) files.push({ name, bytes: raw.slice() });
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files.push({ name, bytes: new Uint8Array(await new Response(stream).arrayBuffer()) });
    } else files.push({ name, error: 'неподдерживаемое сжатие' });
  }
  return files;
}

const SIZE_SUFFIX = /^(.*?)[\s_\-@.]*(18|36|72)(?:x(?:18|36|72))?(?:px)?$/i;

// Groups files into badges: 18/36/72 triples -> subscriber badges, any other PNG -> category badge.
function planImport(files) {
  const groups = new Map(), singles = [];
  for (const f of files) {
    const base = f.name.split('/').pop().replace(/\.png$/i, '');
    const m = base.match(SIZE_SUFFIX);
    if (m && m[1]) {
      const key = m[1].toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: m[1], sizes: {} });
      groups.get(key).sizes[m[2]] = f;
    } else singles.push({ ...f, title: base.slice(0, 40) });
  }
  const plan = [];
  for (const g of groups.values()) {
    if (g.sizes[18] && g.sizes[36] && g.sizes[72]) plan.push({ kind: 'sub', name: g.name, files: [g.sizes[18], g.sizes[36], g.sizes[72]] });
    else singles.push(...Object.values(g.sizes).map((f) => ({ ...f, title: f.name.split('/').pop().replace(/\.png$/i, '').slice(0, 40) })));
  }
  for (const f of singles) plan.push({ kind: 'global', name: f.title, files: [f] });
  return plan;
}

async function bulkImport(fileList) {
  const report = $('#bulkReport');
  const line = (ok, text) => report.append(el('li', { className: ok ? 'ok' : 'err', textContent: (ok ? '✓ ' : '✕ ') + text }));
  report.replaceChildren();
  if (!me.category) { status('Сначала создайте свою категорию', true); return; }
  const files = [];
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      try { files.push(...(await unzip(bytes)).filter((f) => f.error || /\.png$/i.test(f.name))); } catch (err) { line(false, `${file.name}: ${err.message}`); }
    } else files.push({ name: file.name, bytes });
  }
  for (const f of files.filter((x) => x.error)) line(false, `${f.name}: ${f.error}`);
  const plan = planImport(files.filter((x) => !x.error));
  if (!plan.length) { status('В выбранных файлах нет PNG', true); return; }
  let added = 0;
  const own = ownBadges(); // local copy: validates later items against earlier ones without touching `state`
  for (const [i, item] of plan.entries()) {
    status(`Загрузка ${i + 1} из ${plan.length}…`);
    let input;
    if (item.kind === 'sub') {
      const fromName = Number((item.name.match(/\d+/) || [])[0]);
      const used = new Set(own.filter((b) => b.kind === 'sub').map((b) => b.months));
      const months = SUB_MONTHS.includes(fromName) && !used.has(fromName) ? fromName : SUB_MONTHS.find((mo) => !used.has(mo));
      input = { kind: 'sub', months, images: { x1: item.files[0].bytes, x2: item.files[1].bytes, x4: item.files[2].bytes } };
    } else input = { kind: 'global', title: item.name, desc: '', images: { x4: item.files[0].bytes } };
    const label = item.kind === 'sub' ? `${item.name} → значок подписчика (${input.months} мес.)` : `${item.name} → значок категории`;
    const check = validateBadge(input, own);
    if (check.failed) { line(false, `${label}: ${check.items.filter((x) => x.level === 'err').map((x) => x.text).join('; ')}`); continue; }
    try {
      const images = Object.fromEntries(Object.entries(input.images).map(([k, b]) => [k, dataUrl(b).split(',')[1]]));
      const badge = await api('/badges', { method: 'POST', body: { ...input, images } });
      own.push(badge);
      added++;
      line(true, label);
    } catch (err) { line(false, `${label}: ${err.message}`); }
  }
  await refresh();
  status(`Загружено ${added} из ${plan.length}.`, added < plan.length);
}

$('#bulkInput').addEventListener('change', (e) => { bulkImport([...e.target.files]); e.target.value = ''; });
$('#bulkMenuInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  togglePopover(null);
  $('#openAdmin').click(); // results are shown in the badge manager
  bulkImport(files);
});

/* ---------- boot ---------- */
document.title = `${CHANNEL} — Чат трансляции`;
$('#channelTitle').textContent = CHANNEL;
$('#channelName2').textContent = CHANNEL;
$('#welcome').textContent = `Добро пожаловать в чат ${CHANNEL.toLowerCase()}!`;
applyTs();
renderAll();
renderMessages();
syncInput();
refresh();
loadTwitch();
connect();
addEventListener('focus', refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 60000);
