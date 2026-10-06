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
let state = { owners: [], categories: [], badges: [], ...store.get('tbc.state', {}) }; // cached copy renders instantly
if (!Array.isArray(state.owners)) state.owners = [];
let me = { user: null, admin: false };
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

async function refresh(force = false) {
  try {
    const [s, m] = await Promise.all([api('/state'), api('/me')]);
    $('#apiError').hidden = true;
    // periodic refreshes must not rebuild the open pickers (scroll, search) when nothing changed
    if (!force && JSON.stringify([s, m]) === JSON.stringify([state, me])) return;
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
    el('span', { className: 'msg' }, ...renderText(m.text)),
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
let lastNick = null;
function applyServerProfile(me) {
  registered = me;
  $('#nickError').hidden = true;
  profile.nick = me.nick;
  profile.color = me.color;
  saveProfile();
  if (document.activeElement !== $('#nickInput')) $('#nickInput').value = me.nick;
  $('#customColor').value = me.color.toLowerCase();
  renderPreview();
  if (me.nick !== lastNick) { lastNick = me.nick; refresh(); } // the user categories belong to
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
$('#identityBtn').onclick = () => { togglePopover('identity'); applyCollapse(); };
$('#usersBtn').onclick = () => { togglePopover('identity'); applyCollapse(); };
$('#settingsBtn').onclick = () => togglePopover('settings');
$('#openIdentity2').onclick = () => { togglePopover('identity', true); applyCollapse(); };
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => togglePopover(b.dataset.close, false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { togglePopover(null); viewerCard.hidden = true; } });
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.popover, #identityBtn, #settingsBtn, #usersBtn, #emoteBtn')) togglePopover(null);
});
$('#collapseBtn').onclick = () => $('.chat').classList.toggle('collapsed');

const tsToggle = $('#tsToggle');
tsToggle.checked = settings.timestamps;
const applyTs = () => list.classList.toggle('hide-ts', !settings.timestamps);
tsToggle.onchange = () => { settings.timestamps = tsToggle.checked; store.set('tbc.settings', settings); applyTs(); };
$('#clearChat').onclick = () => { if (chatAdmin) wsSend({ type: 'clear' }); togglePopover(null); };
// Moderation entries exist only for the owner.
function renderSettings() { $('#modSection').hidden = !chatAdmin; renderPreview(); }

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
const keyed = (node, key) => { node.dataset.key = key; return node; };

function renderPicker(container, key, groups, noneLabel) {
  const filled = groups.filter((g) => g.badges.length);
  const none = noneTile(key, noneLabel);
  if (!filled.length) { container.replaceChildren(el('div', { className: 'badge-grid' }, none)); return; }
  // the "no badge" tile leads the first grid, like on Twitch
  container.replaceChildren(...filled.map((g, i) => el('div', { className: 'badge-group' },
    g.name ? el('div', { className: 'group-name', textContent: g.name }) : null,
    keyed(el('div', { className: 'badge-grid' }, ...(i === 0 ? [none] : []), ...g.badges.map((b) => badgeTile(b, key))), `${key}:${g.name ?? ''}`))));
}

const KIND_ORDER = { sub: 0, badge: 1, drop: 1, global: 2 };
const slotOf = (b) => (SLOT_OF_UPLOAD[b.kind] === 'sub' ? 'subBadge' : 'otherBadge');

/* ---------- uploaded badges: nick → categories → badges ---------- */
const icon = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="${d}"/></svg>`;
const ICONS = {
  chevron: icon('M9.293 17.293 14.586 12 9.293 6.707l1.414-1.414L17.414 12l-6.707 6.707-1.414-1.414Z'),
  upload: icon('M11 15V7.414L8.207 10.207 6.793 8.793 12 3.586l5.207 5.207-1.414 1.414L13 7.414V15h-2Zm-7-1v6h16v-6h2v8H2v-8h2Z'),
  edit: icon('M17.586 3a2 2 0 0 1 2.828 0l.586.586a2 2 0 0 1 0 2.828L9.414 18H6v-3.414L17.586 3ZM18 5.414 8 15.414V16h.586l10-10L18 5.414ZM3 20h18v2H3v-2Z'),
  trash: icon('M9 2h6v2h6v2H3V4h6V2ZM5 8h2v12h10V8h2v14H5V8Zm4 2h2v8H9v-8Zm4 0h2v8h-2v-8Z'),
  close: icon('M13.414 12l5.293-5.293-1.414-1.414L12 10.586 6.707 5.293 5.293 6.707 10.586 12l-5.293 5.293 1.414 1.414L12 13.414l5.293 5.293 1.414-1.414L13.414 12Z'),
};
const iconBtn = (name, label, onclick) => {
  const b = el('button', { type: 'button', className: 'tree-btn', title: label, ariaLabel: label });
  b.innerHTML = ICONS[name];
  if (onclick) b.onclick = onclick;
  return b;
};

// open/closed state of nick and category nodes, per browser
const treeOpen = new Map(Object.entries(store.get('tbc.tree', {})));
const isOpen = (key, fallback) => treeOpen.get(key) ?? fallback;
const setOpen = (key, open) => { treeOpen.set(key, open); store.set('tbc.tree', Object.fromEntries(treeOpen)); };

function treeNode(key, defaultOpen, head, body, className) {
  const open = isOpen(key, defaultOpen);
  const toggle = el('button', { type: 'button', className: 'tree-toggle' });
  toggle.setAttribute('aria-expanded', String(open));
  toggle.innerHTML = ICONS.chevron;
  toggle.append(...head.label);
  const node = el('div', { className: `tree-node ${className}` },
    el('div', { className: 'tree-head' }, toggle, ...head.actions), body);
  body.hidden = !open;
  toggle.onclick = () => { body.hidden = !body.hidden; toggle.setAttribute('aria-expanded', String(!body.hidden)); setOpen(key, !body.hidden); applyCollapse(); };
  return node;
}

const myId = () => me.user?.id ?? null;
const reports = new Map(); // category id -> [{ ok, text }]
const reportLine = ({ ok, text }) => el('li', { className: ok ? 'ok' : 'err', textContent: (ok ? '✓ ' : '✕ ') + text });
const canManage = (ownerId) => me.admin || ownerId === myId();

function confirmClick(btn, action) {
  btn.onclick = () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      btn.title = 'Нажмите ещё раз, чтобы удалить';
      setTimeout(() => { btn.dataset.armed = ''; btn.classList.remove('armed'); }, 3000);
      return;
    }
    action();
  };
}

const treeStatus = (text, isErr = false) => { const s = $('#treeStatus'); s.textContent = text; s.classList.toggle('err', isErr); };
async function act(fn) {
  try { await fn(); } catch (err) { treeStatus(err.message, true); }
}

function categoryNode(cat, owner) {
  const manage = canManage(owner.id);
  const badges = state.badges.filter((b) => b.categoryId === cat.id)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.months ?? 0) - (b.months ?? 0));
  const grid = keyed(el('div', { className: 'badge-grid' }, ...badges.map((b) => {
    const tile = badgeTile(b, slotOf(b));
    if (!manage) return tile;
    const del = iconBtn('close', 'Удалить значок');
    del.classList.add('tile-del');
    confirmClick(del, () => act(async () => {
      await api(`/badges/${b.id}`, { method: 'DELETE' });
      await refresh();
      treeStatus(`Значок «${b.title}» удалён.`);
    }));
    return el('div', { className: 'tile-wrap' }, tile, del);
  })), `cat:${cat.id}`);
  // upload results survive the re-render that follows every upload
  const report = el('ul', { className: 'bulk-report' }, ...(reports.get(cat.id) || []).map(reportLine));
  report.dataset.report = cat.id;
  const body = el('div', { className: 'tree-body' },
    badges.length ? grid : el('p', { className: 'empty', textContent: manage ? 'Пусто — загрузите PNG или ZIP' : 'Пусто' }), report);
  const name = el('span', { className: 'tree-name', textContent: cat.name });
  const actions = [];
  if (manage) {
    const file = el('input', { type: 'file', accept: '.png,.zip,image/png,application/zip', multiple: true, hidden: true });
    file.onchange = async () => {
      const files = [...file.files];
      file.value = '';
      setOpen(`c:${cat.id}`, true);
      reports.set(cat.id, []);
      report.replaceChildren();
      await bulkImport(files, (ok, text) => {
        const item = { ok, text };
        reports.get(cat.id).push(item);
        document.querySelector(`#badgeTree [data-report="${cat.id}"]`)?.append(reportLine(item));
      }, treeStatus, cat.id);
    };
    const up = el('label', { className: 'tree-btn', title: 'Загрузить значки (PNG или ZIP)', ariaLabel: 'Загрузить значки' }, file);
    up.insertAdjacentHTML('afterbegin', ICONS.upload);
    const ren = iconBtn('edit', 'Переименовать', () => {
      const input = el('input', { className: 'field tree-rename', value: cat.name, maxLength: 25 });
      name.replaceWith(input);
      input.focus(); input.select();
      const save = () => act(async () => {
        const v = input.value.trim();
        if (v && v !== cat.name) await api(`/categories/${cat.id}`, { method: 'PUT', body: { name: v } });
        await refresh(true);
      });
      input.onkeydown = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') refresh(true); };
      input.onblur = save;
    });
    const del = iconBtn('trash', 'Удалить категорию');
    confirmClick(del, () => act(async () => {
      await api(`/categories/${cat.id}`, { method: 'DELETE' });
      await refresh();
      treeStatus(`Категория «${cat.name}» удалена.`);
    }));
    actions.push(up, ren, del);
  }
  return treeNode(`c:${cat.id}`, true, { label: [name, el('span', { className: 'tree-count', textContent: String(badges.length) })], actions }, body, 'tree-cat');
}

function renderTree() {
  const owners = [...state.owners];
  // you always see your own branch (to create the first category), first in the list
  if (me.user && !owners.some((o) => o.id === me.user.id)) owners.unshift(me.user);
  owners.sort((a, b) => (b.id === myId()) - (a.id === myId()));
  $('#badgeTree').replaceChildren(...owners.map((owner) => {
    const mine = owner.id === myId();
    const cats = state.categories.filter((c) => c.ownerId === owner.id);
    const count = state.badges.filter((b) => cats.some((c) => c.id === b.categoryId)).length;
    const body = el('div', { className: 'tree-body' }, ...cats.map((c) => categoryNode(c, owner)));
    if (mine) {
      const input = el('input', { className: 'field', placeholder: 'Новая категория', maxLength: 25, required: true });
      const form = el('form', { className: 'tree-new' }, input, el('button', { className: 'btn', textContent: 'Создать' }));
      form.onsubmit = (e) => {
        e.preventDefault();
        act(async () => {
          const cat = await api('/categories', { method: 'POST', body: { name: input.value } });
          setOpen(`c:${cat.id}`, true);
          await refresh();
          treeStatus(`Категория «${cat.name}» создана — загрузите в неё PNG или ZIP.`);
        });
      };
      body.append(form);
    }
    const actions = [];
    if (canManage(owner.id) && cats.length) {
      const del = iconBtn('trash', mine ? 'Удалить все мои категории' : `Удалить все категории ${owner.nick}`);
      confirmClick(del, () => act(async () => {
        await api(`/owners/${owner.id}`, { method: 'DELETE' });
        await refresh();
        treeStatus(`Категории ${owner.nick} удалены.`);
      }));
      actions.push(del);
    }
    const nick = el('span', { className: 'tree-name tree-nick', textContent: owner.nick + (mine ? ' (вы)' : '') });
    nick.style.color = readable(owner.color);
    return treeNode(`o:${owner.id}`, mine, { label: [nick, el('span', { className: 'tree-count', textContent: `${cats.length} кат. · ${count}` })], actions }, body, 'tree-owner');
  }));
  if (!owners.length) $('#badgeTree').append(el('p', { className: 'empty', textContent: 'Пока никто не загрузил значки' }));
  applyCollapse();
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
  renderTree();
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
  applyCollapse();
}

// Long badge groups show their first row; the rest opens with "Показать все" (search results are always expanded).
const expandedGrids = new Set();
function applyCollapse() {
  if ($('#identity').hidden) return; // needs layout to know what fits in a row
  const searching = Boolean($('#globalSearch').value.trim());
  for (const grid of document.querySelectorAll('#identity .badge-grid[data-key]')) {
    const key = grid.dataset.key;
    grid.nextElementSibling?.classList.contains('more-badges') && grid.nextElementSibling.remove();
    grid.classList.remove('collapsed');
    const tiles = [...grid.children].filter((t) => !t.hidden);
    if (!tiles.length) continue;
    const overflow = tiles.filter((t) => t.offsetTop > tiles[0].offsetTop).length;
    if (!overflow || (searching && grid.closest('#globalGrid'))) continue;
    const open = expandedGrids.has(key);
    if (!open) grid.classList.add('collapsed');
    const btn = el('button', { type: 'button', className: 'more-badges', textContent: open ? 'Свернуть' : `Показать все (ещё ${overflow})` });
    btn.onclick = () => { if (open) expandedGrids.delete(key); else expandedGrids.add(key); applyCollapse(); };
    grid.after(btn);
  }
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

const renderAll = () => renderIdentity();

/* ---------- moving rights to another browser = copying the key there ---------- */
$('#copyKey').onclick = async () => {
  try { await navigator.clipboard.writeText(browserKey); treeStatus('Ключ скопирован — вставьте его на другом устройстве.'); } catch { treeStatus(browserKey); }
};
$('#keyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('#keyInput').value.trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) { treeStatus('Неверный ключ', true); return; }
  store.set('tbc.key', key);
  location.reload(); // the chat socket and API both identify by this key
});

/* ---------- bulk import: PNG files or a ZIP archive ---------- */
const dataUrl = (bytes) => `data:image/png;base64,${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))}`;

// Twitch: subscriber badges "must have a transparent background". An alpha channel alone isn't enough,
// so check the actual pixels (the server can only check the PNG header).
async function hasTransparency(bytes) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
    return false;
  } catch { return true; } // undecodable files are rejected by the PNG checks anyway
}

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
  for (const f of singles) plan.push({ kind: 'badge', name: f.title.slice(0, 25), files: [f] });
  return plan;
}

async function bulkImport(fileList, line, say, categoryId) {
  const files = [];
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      try { files.push(...(await unzip(bytes)).filter((f) => f.error || /\.png$/i.test(f.name))); } catch (err) { line(false, `${file.name}: ${err.message}`); }
    } else files.push({ name: file.name, bytes });
  }
  for (const f of files.filter((x) => x.error)) line(false, `${f.name}: ${f.error}`);
  const plan = planImport(files.filter((x) => !x.error));
  if (!plan.length) { say('В выбранных файлах нет PNG', true); return; }
  let added = 0;
  const own = state.badges.filter((b) => b.categoryId === categoryId); // local copy: validates later items against earlier ones without touching `state`
  for (const [i, item] of plan.entries()) {
    say(`Загрузка ${i + 1} из ${plan.length}…`);
    let input;
    if (item.kind === 'sub') {
      const fromName = Number((item.name.match(/\d+/) || [])[0]);
      const used = new Set(own.filter((b) => b.kind === 'sub').map((b) => b.months));
      const months = SUB_MONTHS.includes(fromName) && !used.has(fromName) ? fromName : SUB_MONTHS.find((mo) => !used.has(mo));
      input = { kind: 'sub', months, images: { x1: item.files[0].bytes, x2: item.files[1].bytes, x4: item.files[2].bytes } };
    } else input = { kind: 'badge', title: item.name, images: { x4: item.files[0].bytes } };
    const label = item.kind === 'sub' ? `${item.name} → значок подписчика (${input.months} мес.)` : `${item.name} → значок канала`;
    const check = validateBadge(input, own);
    if (input.kind === 'sub') {
      for (const [k, size] of [['x1', 18], ['x2', 36], ['x4', 72]]) {
        if (!(await hasTransparency(input.images[k]))) { check.failed = true; check.items.push({ level: 'err', text: `${size}px: фон непрозрачный — Twitch требует прозрачный фон` }); }
      }
    }
    if (check.failed) { line(false, `${label}: ${check.items.filter((x) => x.level === 'err').map((x) => x.text).join('; ')}`); continue; }
    try {
      const images = Object.fromEntries(Object.entries(input.images).map(([k, b]) => [k, dataUrl(b).split(',')[1]]));
      const badge = await api('/badges', { method: 'POST', body: { ...input, images, categoryId } });
      own.push(badge);
      added++;
      const warns = check.items.filter((x) => x.level === 'warn').map((x) => x.text);
      line(true, warns.length ? `${label} (! ${warns.join('; ')})` : label);
    } catch (err) { line(false, `${label}: ${err.message}`); }
  }
  await refresh();
  say(`Загружено ${added} из ${plan.length}.`, added < plan.length);
}

/* ---------- emotes: Twitch globals + 7TV / BTTV / FFZ (global and channel), like the browser extensions ---------- */
const CHANNEL_ID = '415309986'; // twitch user id of the channel
// Classic Twitch global emotes (Helix needs an app token; these ids are stable and verified to load).
const TWITCH_EMOTES = {
  Kappa: 25, Keepo: 1902, LUL: 425618, '4Head': 354, Kreygasm: 41, ResidentSleeper: 245, WutFace: 28087, NotLikeThis: 58765,
  SeemsGood: 64138, BabyRage: 22639, DansGame: 33, FailFish: 360, HeyGuys: 30259, Jebaited: 114836, KappaPride: 55338,
  MrDestructoid: 28, PJSalt: 36, SwiftRage: 34, TriHard: 120232, VoHiYo: 81274, CoolStoryBob: 123171, cmonBruh: 84608,
  BloodTrail: 69, OpieOP: 100590, SMOrc: 52, KomodoHype: 81273, PogChamp: 305954156, EleGiggle: 4339, CoolCat: 58127,
  DoritosChip: 102242, GivePLZ: 112291, TakeNRG: 112292, FrankerZ: 65, ANELE: 3792, BrokeBack: 4057, CorgiDerp: 49106,
  DarkMode: 461298, HSWP: 446979, KappaHD: 2867, MingLee: 68856, Mau5: 30134, Squid1: 191762, TwitchUnity: 196892,
  VirtualHug: 301696001, HotPokket: 357, Kappu: 160397, PopCorn: 724216, '<3': 9, ':)': 1, ':(': 2, ':D': 3, ';)': 11,
  ':P': 12, ':O': 8, 'B)': 7, 'R)': 14, ':/': 10, '>(': 4, 'O_o': 6, ':Z': 5, ';P': 13,
};
const PROVIDERS = { twitch: 'Twitch', '7tv': '7TV', bttv: 'BTTV', ffz: 'FFZ' };
let emotes = new Map(); // code -> { code, provider, scope, x1, x2, x4, zw }

// a slow provider must not hold back the others
const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
const stvList = (set, scope) => (set?.emotes ?? []).map((e) => {
  const host = `https:${e.data.host.url}`;
  return { code: e.name, provider: '7tv', scope, x1: `${host}/1x.webp`, x2: `${host}/2x.webp`, x4: `${host}/4x.webp`, zw: Boolean((e.flags ?? 0) & 1) };
});
const bttvList = (list, scope) => list.map((e) => ({
  code: e.code, provider: 'bttv', scope, x1: `https://cdn.betterttv.net/emote/${e.id}/1x`, x2: `https://cdn.betterttv.net/emote/${e.id}/2x`, x4: `https://cdn.betterttv.net/emote/${e.id}/3x`,
  zw: ['cvHazmat', 'cvMask', 'IceCold', 'SoSnowy', 'TopHat', 'SantaHat', 'ReinDeer', 'CandyCane'].includes(e.code),
}));
const ffzList = (sets, scope) => Object.values(sets ?? {}).flatMap((s) => s.emoticons.map((e) => ({
  code: e.name, provider: 'ffz', scope, x1: e.urls['1'], x2: e.urls['2'] || e.urls['1'], x4: e.urls['4'] || e.urls['2'] || e.urls['1'], zw: false,
})));

async function loadEmotes() {
  const cached = store.get('tbc.emotes', null);
  if (cached && Date.now() - cached.at < 6 * 3600_000) { setEmotes(cached.list); return; }
  const twitchList = Object.entries(TWITCH_EMOTES).map(([code, id]) => {
    const u = (n) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/${n}`;
    return { code, provider: 'twitch', scope: 'global', x1: u('1.0'), x2: u('2.0'), x4: u('3.0'), zw: false };
  });
  setEmotes(twitchList); // usable right away, extension emotes follow
  const [stvG, stvC, bttvG, bttvC, ffzG, ffzC] = await Promise.allSettled([
    getJson('https://7tv.io/v3/emote-sets/global'),
    getJson(`https://7tv.io/v3/users/twitch/${CHANNEL_ID}`),
    getJson('https://api.betterttv.net/3/cached/emotes/global'),
    getJson(`https://api.betterttv.net/3/cached/users/twitch/${CHANNEL_ID}`),
    getJson('https://api.frankerfacez.com/v1/set/global'),
    getJson(`https://api.frankerfacez.com/v1/room/id/${CHANNEL_ID}`),
  ]);
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  const ffzGlobal = ok(ffzG);
  // first one wins on name clashes, in the order chat extensions use: Twitch, channel emotes, then globals
  const list = [
    ...twitchList,
    ...stvList(ok(stvC)?.emote_set, 'channel'),
    ...bttvList([...(ok(bttvC)?.channelEmotes ?? []), ...(ok(bttvC)?.sharedEmotes ?? [])], 'channel'),
    ...ffzList(ok(ffzC)?.sets, 'channel'),
    ...stvList(ok(stvG), 'global'),
    ...bttvList(ok(bttvG) ?? [], 'global'),
    ...ffzList(ffzGlobal && Object.fromEntries(ffzGlobal.default_sets.map((id) => [id, ffzGlobal.sets[id]])), 'global'),
  ];
  // cache only complete results, so a failed provider is retried on the next visit
  if ([stvG, bttvG, ffzG].every((r) => r.status === 'fulfilled')) store.set('tbc.emotes', { at: Date.now(), list });
  setEmotes(list);
}

function setEmotes(list) {
  emotes = new Map();
  for (const e of list) if (!emotes.has(e.code)) emotes.set(e.code, e);
  renderMessages(); // re-render existing lines with emotes
  renderEmotePicker();
}

const emoteImg = (e) => {
  const img = el('img', { className: 'emote', src: e.x1, alt: e.code }); // not lazy: lazy images inside a hidden popover never start loading
  img.srcset = `${e.x1} 1x, ${e.x2} 2x, ${e.x4} 4x`;
  Object.assign(img.dataset, { title: e.code, desc: `${PROVIDERS[e.provider]} · ${e.scope === 'channel' ? 'смайлик канала' : 'глобальный'}`, big: e.x4 });
  return img;
};

// Message text -> text nodes + emote images; zero-width emotes (7TV) stack on top of the previous emote.
function renderText(text) {
  const out = [];
  for (const part of text.split(/(\s+)/)) {
    const e = part && emotes.get(part);
    if (!e) { out.push(document.createTextNode(part)); continue; }
    const prev = out.findLast((n) => n.nodeType === 1 || n.textContent.trim());
    if (e.zw && prev?.classList?.contains('emote-stack')) { prev.append(emoteImg(e)); continue; }
    out.push(el('span', { className: 'emote-stack' }, emoteImg(e)));
  }
  return out;
}

/* emote picker */
let emoteTab = 'all';
function renderEmotePicker() {
  const q = $('#emoteSearch').value.trim().toLowerCase();
  const list = [...emotes.values()].filter((e) => (emoteTab === 'all' || e.provider === emoteTab) && (!q || e.code.toLowerCase().includes(q)));
  const groups = [['channel', 'Смайлики канала'], ['global', 'Глобальные']].map(([scope, title]) => [title, list.filter((e) => e.scope === scope)]);
  $('#emoteGrid').replaceChildren(...groups.filter(([, l]) => l.length).map(([title, l]) => el('div', { className: 'emote-group' },
    el('div', { className: 'group-name', textContent: `${title} · ${l.length}` }),
    el('div', { className: 'emote-grid' }, ...l.map((e) => {
      const b = el('button', { type: 'button', className: 'emote-opt', title: e.code, ariaLabel: e.code }, emoteImg(e));
      b.onclick = () => insertEmote(e.code);
      return b;
    })))));
  if (!list.length) $('#emoteGrid').append(el('p', { className: 'empty', textContent: emotes.size ? 'Ничего не найдено' : 'Загрузка смайликов…' }));
}
function insertEmote(code) {
  const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start), after = input.value.slice(end);
  const ins = `${before && !/\s$/.test(before) ? ' ' : ''}${code} `;
  input.value = before + ins + after;
  input.focus();
  input.selectionStart = input.selectionEnd = before.length + ins.length;
  syncInput();
}
$('#emoteBtn').onclick = () => { togglePopover('emotes'); if (!$('#emotes').hidden) $('#emoteSearch').focus(); };
$('#emoteSearch').addEventListener('input', renderEmotePicker);
document.querySelectorAll('.emote-tab').forEach((t) => {
  t.onclick = () => {
    emoteTab = t.dataset.tab;
    document.querySelectorAll('.emote-tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    renderEmotePicker();
  };
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
loadEmotes();
connect();
addEventListener('focus', refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 60000);
