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

const svgBadge = (bg, path) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><rect width="18" height="18" rx="2" fill="${bg}"/>${path}</svg>`);

const ROLES = {
  broadcaster: { title: 'Стример', src: svgBadge('#e91916', '<path fill="#fff" d="M3 5h8v8H3zM11 7.5l4-2.5v8l-4-2.5z"/>') },
  moderator: { title: 'Модератор', src: svgBadge('#00ad03', '<path fill="#fff" d="M13.5 3H15v1.5L8.6 10.9l1.4 1.4-1.1 1.1-1.2-1.2-2.6 2.6-1.3-1.3 2.6-2.6-1.2-1.2 1.1-1.1 1.4 1.4z"/>') },
  vip: { title: 'VIP', src: svgBadge('#e005b9', '<path fill="#fff" d="M5.5 4h7L15 7.5 9 14.5 3 7.5z"/>') },
};

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

async function refresh() {
  try {
    const [s, m] = await Promise.all([api('/state'), api('/me')]);
    state = s; me = m;
    store.set('tbc.state', state);
    $('#apiError').hidden = true;
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
  return b.desc || 'Общий значок';
}

// Messages store this view so old lines keep the badge they were sent with.
const badgeView = (b) => ({ images: b.images, title: b.title, desc: describe(b) });
const bigSrc = (imgs) => imgs.x4 || imgs.x2 || imgs.x1;

const byId = (id) => state.badges.find((b) => b.id === id);
const categoryName = (id) => state.categories.find((c) => c.id === id)?.name ?? '—';
const ownBadges = () => (me.category ? state.badges.filter((b) => b.categoryId === me.category.id) : []);

// Twitch display order: role -> channel (sub / drop) -> global
function currentBadges() {
  const out = [];
  const role = ROLES[profile.role];
  if (role) out.push({ images: { x4: role.src }, title: role.title, desc: '' });
  for (const id of [profile.channelBadge, profile.globalBadge]) {
    const b = id && byId(id);
    if (b) out.push(badgeView(b));
  }
  return out;
}

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
  { nick: 'Viewer', color: '#FF0000', role: null, channelBadge: null, globalBadge: null },
  store.get('tbc.profile', {}),
);
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
  s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('width', '16'); s.setAttribute('height', '16');
  s.innerHTML = '<path fill="currentColor" d="M12 2H8v1H3v2h14V3h-5V2zM4 7v9a2 2 0 002 2h8a2 2 0 002-2V7h-2v9H6V7H4z"/><path fill="currentColor" d="M11 7H9v7h2V7z"/>';
  return s;
};

function lineEl(m) {
  const line = el('div', { className: 'line' });
  line.dataset.id = m.id;
  line.append(el('span', { className: 'ts', textContent: fmtTime(m.t) }));
  if (profile.role === 'broadcaster' || profile.role === 'moderator') {
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
function optButton(pressed, label, content, onPick) {
  const btn = el('button', { type: 'button', className: 'badge-opt', title: label, ariaLabel: label });
  btn.setAttribute('aria-pressed', String(pressed));
  if (content) btn.append(content); else { btn.classList.add('none'); btn.textContent = '⦸'; }
  btn.onclick = onPick;
  return btn;
}

// One grid per uploader category, like Twitch groups badges by source.
function badgeOptions(container, kinds, key) {
  const none = el('div', { className: 'badge-grid' }, optButton(!profile[key], 'Без значка', null, () => pick(key, null)));
  const groups = state.categories.map((cat) => {
    const badges = state.badges.filter((b) => b.categoryId === cat.id && kinds.includes(b.kind))
      .sort((a, b) => (a.kind === b.kind ? (a.months ?? 0) - (b.months ?? 0) : a.kind === 'sub' ? -1 : 1));
    if (!badges.length) return null;
    return el('div', { className: 'badge-group' },
      el('div', { className: 'group-name', textContent: cat.name }),
      el('div', { className: 'badge-grid' }, ...badges.map((b) => {
        const v = badgeView(b);
        const img = el('img', { src: bigSrc(v.images), alt: '' });
        Object.assign(img.dataset, { title: v.title, desc: v.desc, big: img.src });
        return optButton(profile[key] === b.id, `${v.title} — ${v.desc}`, img, () => pick(key, b.id));
      })));
  }).filter(Boolean);
  container.replaceChildren(none, ...(groups.length ? groups : [el('p', { className: 'empty', textContent: 'Значков пока нет' })]));
}

function pick(key, value) {
  profile[key] = value;
  saveProfile();
  renderIdentity();
}

function renderIdentity() {
  // drop references to badges that no longer exist
  for (const k of ['channelBadge', 'globalBadge']) if (profile[k] && !byId(profile[k])) { profile[k] = null; saveProfile(); }

  const badges = currentBadges();
  $('#preview').replaceChildren(...badges.map(badgeImg),
    el('span', { className: 'name', textContent: profile.nick, style: `color:${readable(profile.color)}` }));
  $('#identityBtn').replaceChildren(...badges.map(badgeImg));
  if (!badges.length) $('#identityBtn').textContent = '☺';

  const roleGrid = $('#roleGrid');
  roleGrid.replaceChildren(optButton(!ROLES[profile.role], 'Зритель', null, () => { pick('role', null); renderMessages(); }));
  for (const [key, r] of Object.entries(ROLES)) {
    roleGrid.append(optButton(profile.role === key, r.title, el('img', { src: r.src, alt: '' }), () => { pick('role', key); renderMessages(); }));
  }
  badgeOptions($('#channelGrid'), ['sub', 'drop'], 'channelBadge');
  badgeOptions($('#globalGrid'), ['global'], 'globalBadge');

  $('#colorGrid').replaceChildren(...COLORS.map((c) => {
    const b = el('button', { type: 'button', className: 'color-opt', title: c, ariaLabel: `Цвет ${c}`, style: `background:${c}` });
    b.setAttribute('aria-pressed', String(profile.color.toUpperCase() === c));
    b.onclick = () => pick('color', c);
    return b;
  }));
  $('#customColor').value = profile.color.toLowerCase();
  const nick = $('#nickInput');
  if (document.activeElement !== nick) nick.value = profile.nick;
}

$('#nickInput').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (v) { profile.nick = v; saveProfile(); renderIdentity(); }
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

$('#openAdmin').onclick = () => { togglePopover(null); status(''); renderManager(); dialog.showModal(); refresh(); };
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
addEventListener('focus', refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 60000);
