import { validateBadge, deleteBlocker, UNLOCK_RANGE, SUB_MONTHS } from './rules.js';

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
const ROLE_SETS = ['broadcaster', 'lead_moderator', 'moderator', 'vip', 'artist-badge', 'partner', 'staff', 'admin', 'global_mod'];
const CHANNEL_SETS = ['subscriber', 'founder'];
const EXTRA_SETS = ['sub-gifter', 'sub-gift-leader', 'bits', 'bits-leader', 'predictions', 'hype-train', 'moments', 'clips-leader'];
const SLOTS = ['role', 'channelBadge', 'extraBadge', 'globalBadge']; // Twitch display order in a chat line

/* ---------- identity for uploads: a random secret kept in this browser (+ optional owner admin key) ---------- */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let browserKey = store.get('tbc.key', null);
if (!browserKey) { browserKey = b64url(crypto.getRandomValues(new Uint8Array(32))); store.set('tbc.key', browserKey); }

// The owner opens the site once as …/#admin=<key>; the key is kept in this browser and removed from the URL.
const adminFromUrl = new URLSearchParams(location.hash.slice(1)).get('admin');
if (adminFromUrl) { store.set('tbc.adminKey', adminFromUrl); history.replaceState(null, '', location.pathname + location.search); }
const adminKey = store.get('tbc.adminKey', null);

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
  const taken = new Set([...ROLE_SETS, ...CHANNEL_SETS, ...EXTRA_SETS]);
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
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

function describe(b) {
  if (b.kind === 'drop') {
    const n = b.unlock.amount;
    const how = {
      sub: `${n} ${plural(n, 'подписка', 'подписки', 'подписок')} или подарков`,
      watch: `${n} ч просмотра`,
      top: `топ-${n} дарителей события`,
    }[b.unlock.type];
    return `Creator Badge Drop «${b.event.name}» · ${how}`;
  }
  if (b.kind === 'sub') return 'Значок подписчика';
  if (b.kind === 'twitch') return b.desc && b.desc !== b.title ? b.desc : 'Значок Twitch';
  return b.desc || 'Общий значок';
}

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
  img.onerror = () => img.remove();
  return img;
}

/* ---------- state ---------- */
const profile = Object.assign(
  { nick: 'Viewer', color: '#FF0000', role: null, channelBadge: null, extraBadge: null, globalBadge: null },
  store.get('tbc.profile', {}),
);
// v1 stored roles as plain names with home-made icons
if (profile.role && !profile.role.startsWith('tw:')) profile.role = `tw:${profile.role}:1`;
let messages = store.get('tbc.messages', []);
const settings = Object.assign({ timestamps: true }, store.get('tbc.settings', {}));
const saveProfile = () => store.set('tbc.profile', profile);
const saveMessages = () => store.set('tbc.messages', messages);

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

const isMod = () => ['tw:broadcaster:1', 'tw:moderator:1', 'tw:lead_moderator:1'].includes(profile.role);

function lineEl(m) {
  const line = el('div', { className: 'line' });
  line.dataset.id = m.id;
  line.append(el('span', { className: 'ts', textContent: fmtTime(m.t) }));
  if (isMod()) {
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

function addMessage(text) {
  const m = { id: crypto.randomUUID(), t: Date.now(), nick: profile.nick, color: profile.color, badges: currentBadges(), text };
  messages.push(m);
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES);
    list.firstElementChild?.remove();
  }
  saveMessages();
  list.append(lineEl(m));
  scroller.scrollTop = scroller.scrollHeight;
}

list.addEventListener('click', (e) => {
  const btn = e.target.closest('.mod-btn');
  if (!btn) return;
  const line = btn.closest('.line');
  messages = messages.filter((m) => m.id !== line.dataset.id);
  saveMessages();
  line.remove();
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
  addMessage(text.slice(0, MAX_MESSAGE_LEN));
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') togglePopover(null); });
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.popover, #identityBtn, #settingsBtn, #usersBtn')) togglePopover(null);
});
$('#collapseBtn').onclick = () => $('.chat').classList.toggle('collapsed');

const tsToggle = $('#tsToggle');
tsToggle.checked = settings.timestamps;
const applyTs = () => list.classList.toggle('hide-ts', !settings.timestamps);
tsToggle.onchange = () => { settings.timestamps = tsToggle.checked; store.set('tbc.settings', settings); applyTs(); };
$('#clearChat').onclick = () => { messages = []; saveMessages(); renderMessages(); togglePopover(null); };

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

const uploaded = (kinds) => state.categories.map((cat) => ({
  name: cat.name,
  badges: state.badges.filter((b) => b.categoryId === cat.id && kinds.includes(b.kind))
    .sort((a, b) => (a.kind === b.kind ? (a.months ?? 0) - (b.months ?? 0) : a.kind === 'sub' ? -1 : 1)),
}));

function pick(key, value) {
  profile[key] = value;
  saveProfile();
  for (const btn of document.querySelectorAll(`[data-slot="${key}"] .badge-opt`)) {
    btn.setAttribute('aria-pressed', String(btn.dataset.id === (value ?? '')));
  }
  renderPreview();
  if (key === 'role') renderMessages(); // mod tools depend on the role
}

function renderPreview() {
  const badges = currentBadges();
  $('#preview').replaceChildren(...badges.map(badgeImg),
    el('span', { className: 'name', textContent: profile.nick, style: `color:${readable(profile.color)}` }));
  $('#identityBtn').replaceChildren(...badges.map(badgeImg));
  if (!badges.length) $('#identityBtn').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" fill-rule="evenodd" d="M6 8a6 6 0 1 1 12 0A6 6 0 0 1 6 8Zm6 4a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm-5 4a4 4 0 0 0-4 4v2h2v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2h2v-2a4 4 0 0 0-4-4H7Z" clip-rule="evenodd"/></svg>';
  $('#modTools').hidden = !isMod();
  for (const b of document.querySelectorAll('.color-opt')) b.setAttribute('aria-pressed', String(profile.color.toUpperCase() === b.title));
}

function renderIdentity() {
  // drop references to badges that no longer exist (only once Twitch data is known)
  for (const k of SLOTS) {
    if (profile[k] && !byId(profile[k]) && (twitch.length || !profile[k].startsWith('tw:'))) { profile[k] = null; saveProfile(); }
  }
  renderPicker($('#roleGrid'), 'role', [{ badges: twitchSets(ROLE_SETS) }], 'Зритель');
  renderPicker($('#channelGrid'), 'channelBadge', [...uploaded(['sub', 'drop']), { name: 'Twitch (по умолчанию)', badges: twitchSets(CHANNEL_SETS) }], 'Без значка');
  renderPicker($('#extraGrid'), 'extraBadge', [{ badges: twitchSets(EXTRA_SETS) }], 'Без значка');
  renderPicker($('#globalGrid'), 'globalBadge', [...uploaded(['global']), { name: 'Twitch', badges: twitchGlobal() }], 'Без значка');
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

$('#nickInput').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (v) { profile.nick = v; saveProfile(); renderPreview(); }
});
$('#nickInput').addEventListener('blur', (e) => { e.target.value = profile.nick; });
$('#customColor').addEventListener('input', (e) => pick('color', e.target.value.toUpperCase()));

function renderAll() {
  renderIdentity();
  renderManager();
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
    const head = el('div', { className: 'cat-head' }, el('b', { textContent: cat.name + (mine ? ' (моя)' : '') }),
      el('span', { className: 'muted', textContent: `${badges.length} шт.` }));
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
addEventListener('focus', refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 60000);
