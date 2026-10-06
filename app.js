'use strict';

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
const KB = 1024;
const DROP_MAX_BYTES = 25 * KB;      // Creator Badge Drops: "maximum file size is 25kb"
const DROP_MIN_RECOMMENDED = 120;    // "recommended size is 120x120 pixels or larger"
const DROP_MAX_DAYS = 28;            // "event period cannot exceed 28 days"
const SUB_MAX_BYTES = 25 * KB;       // subscriber badges: 25 KB per file
const GLOBAL_MAX_BYTES = 100 * KB;
const SUB_MONTHS = [1, 2, 3, 6, 9, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72, 78, 84, 90, 96, 102, 108, 114, 120];
// Creator Badge Drops limits per help.twitch.tv/s/article/creator-badge-rewards (raised in Aug 2026 from 1–5 subs / 8 h).
const UNLOCK_RANGE = { sub: [1, 100], watch: [1, 24] };
const TOP_SPOTS = [1, 3, 5, 10];
const DROP_NAME_MAX = 25;

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

/* ---------- repository (badge storage) ---------- */
const repo = (() => {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.split('.')[0];
    const first = location.pathname.split('/').filter(Boolean)[0];
    return { owner, name: first && !first.includes('.') ? first : `${owner}.github.io`, fixed: true };
  }
  return { ...store.get('tbc.repo', { owner: '', name: '' }), fixed: false };
})();

let token = store.get('tbc.token', null);
let manifest = { version: 1, channel: 'AlkatrazzJR', badges: [] };
const freshImages = new Map(); // path -> data URL for images uploaded this session (Pages deploy lags ~1 min)

const imgSrc = (path) => freshImages.get(path) || path;

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    cache: 'no-store', // API GETs are cacheable for 60 s; a stale ref breaks back-to-back commits
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub ${res.status}: ${body.message || res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

const repoPath = () => `/repos/${repo.owner}/${repo.name}`;
const MANIFEST_PATH = 'badges/manifest.json';

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function fetchManifestPublic() {
  try {
    const res = await fetch(`${MANIFEST_PATH}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch { /* offline or opened from file:// */ }
  return null;
}

async function fetchManifestApi(ref = '') {
  const file = await gh(`${repoPath()}/contents/${MANIFEST_PATH}${ref ? `?ref=${ref}` : ''}`);
  return JSON.parse(b64ToText(file.content));
}

const manifestBytes = (m) => new TextEncoder().encode(JSON.stringify(m, null, 2) + '\n');

// Read-modify-write of the manifest as one atomic commit. The manifest is read at the exact head commit that becomes
// the parent, and the ref update is fast-forward only, so a concurrent push makes it retry instead of losing badges.
// `change(latest)` mutates the manifest and returns image file changes ({ path, bytes } / bytes: null = delete).
async function updateManifest(message, change) {
  const base = repoPath();
  const { default_branch: branch } = await gh(base);
  for (let attempt = 1; ; attempt++) {
    const { object: { sha: headSha } } = await gh(`${base}/git/ref/heads/${branch}`);
    const head = await gh(`${base}/git/commits/${headSha}`);
    const latest = await fetchManifestApi(headSha);
    const files = [...await change(latest), { path: MANIFEST_PATH, bytes: manifestBytes(latest) }];
    const tree = await Promise.all(files.map(async (c) => ({
      path: c.path, mode: '100644', type: 'blob',
      sha: c.bytes ? (await gh(`${base}/git/blobs`, {
        method: 'POST', body: JSON.stringify({ content: bytesToB64(c.bytes), encoding: 'base64' }),
      })).sha : null,
    })));
    const newTree = await gh(`${base}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
    const commit = await gh(`${base}/git/commits`, {
      method: 'POST', body: JSON.stringify({ message: message(latest), tree: newTree.sha, parents: [headSha] }),
    });
    try {
      await gh(`${base}/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
      return { manifest: latest, files };
    } catch (err) {
      if (attempt >= 4 || !/fast forward/i.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function loadManifest() {
  let m = null;
  if (token) { try { m = await fetchManifestApi(); } catch { /* fall back to the deployed copy */ } }
  m ??= await fetchManifestPublic();
  if (m && Array.isArray(m.badges)) manifest = m;
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

// Messages store this view (repo paths, not data URLs) so old lines keep the badge they were sent with.
const badgeView = (b) => ({ images: b.images, title: b.title, desc: describe(b) });
const bigSrc = (imgs) => imgSrc(imgs.x4 || imgs.x2 || imgs.x1);

const byId = (id) => manifest.badges.find((b) => b.id === id);
const channelBadges = () => manifest.badges.filter((b) => b.kind === 'sub' || b.kind === 'drop')
  .sort((a, b) => (a.kind === b.kind ? (a.months ?? 0) - (b.months ?? 0) : a.kind === 'sub' ? -1 : 1));
const globalBadges = () => manifest.badges.filter((b) => b.kind === 'global');

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
  const img = el('img', { className: 'badge', src: imgSrc(imgs.x1 || imgs.x4), alt: v.title, width: 18, height: 18 });
  const set = [['x1', '1x'], ['x2', '2x'], ['x4', '4x']].filter(([k]) => imgs[k]);
  if (set.length > 1) img.srcset = set.map(([k, d]) => `${imgSrc(imgs[k])} ${d}`).join(', ');
  img.dataset.title = v.title;
  img.dataset.desc = v.desc || '';
  img.dataset.big = bigSrc(imgs);
  img.onerror = () => img.remove();
  return img;
}

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

/* ---------- state ---------- */
const profile = Object.assign(
  { nick: 'AlkatrazzJR', color: '#FF0000', role: 'broadcaster', channelBadge: null, globalBadge: null },
  store.get('tbc.profile', {}),
);
let messages = store.get('tbc.messages', []);
const settings = Object.assign({ timestamps: true }, store.get('tbc.settings', {}));
const saveProfile = () => store.set('tbc.profile', profile);
const saveMessages = () => store.set('tbc.messages', messages);

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

/* ---------- identity card ---------- */
function optButton(pressed, label, content, onPick) {
  const btn = el('button', { type: 'button', className: 'badge-opt', title: label, ariaLabel: label });
  btn.setAttribute('aria-pressed', String(pressed));
  if (content) btn.append(content); else { btn.classList.add('none'); btn.textContent = '⦸'; }
  btn.onclick = onPick;
  return btn;
}

function badgeOptions(container, badges, key) {
  container.replaceChildren(optButton(!profile[key], 'Без значка', null, () => pick(key, null)));
  if (!badges.length) container.append(el('span', { className: 'empty', textContent: 'Значков пока нет' }));
  for (const b of badges) {
    const v = badgeView(b);
    const img = el('img', { src: bigSrc(v.images), alt: '' });
    img.dataset.title = v.title; img.dataset.desc = v.desc; img.dataset.big = img.src;
    container.append(optButton(profile[key] === b.id, `${v.title} — ${v.desc}`, img, () => pick(key, b.id)));
  }
}

function pick(key, value) {
  profile[key] = value;
  saveProfile();
  renderIdentity();
}

function renderIdentity() {
  // drop references to badges that were deleted from the manifest
  for (const k of ['channelBadge', 'globalBadge']) if (profile[k] && !byId(profile[k])) { profile[k] = null; saveProfile(); }

  const preview = $('#preview');
  preview.replaceChildren(...currentBadges().map(badgeImg),
    el('span', { className: 'name', textContent: profile.nick, style: `color:${readable(profile.color)}` }));
  $('#identityBtn').replaceChildren(...currentBadges().map(badgeImg));
  if (!$('#identityBtn').children.length) $('#identityBtn').textContent = '☺';

  const roleGrid = $('#roleGrid');
  roleGrid.replaceChildren(optButton(!ROLES[profile.role], 'Зритель', null, () => { pick('role', null); renderMessages(); }));
  for (const [key, r] of Object.entries(ROLES)) {
    roleGrid.append(optButton(profile.role === key, r.title, el('img', { src: r.src, alt: '' }), () => { pick('role', key); renderMessages(); }));
  }
  badgeOptions($('#channelGrid'), channelBadges(), 'channelBadge');
  badgeOptions($('#globalGrid'), globalBadges(), 'globalBadge');

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
  const ch = manifest.channel || 'channel';
  document.title = `${ch} — Чат трансляции`;
  $('#channelTitle').textContent = ch;
  $('#channelName2').textContent = ch;
  $('#welcome').textContent = `Добро пожаловать в чат ${ch.toLowerCase()}!`;
  renderIdentity();
  renderBadgeList();
}

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

/* ---------- PNG inspection ---------- */
async function inspectPng(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = { bytes, size: bytes.length, png: false, width: 0, height: 0, animated: false, alpha: false };
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !sig.every((b, i) => bytes[i] === b)) return info;
  info.png = true;
  const dv = new DataView(bytes.buffer);
  for (let off = 8; off + 8 <= bytes.length;) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (type === 'IHDR') {
      info.width = dv.getUint32(off + 8);
      info.height = dv.getUint32(off + 12);
      const colorType = bytes[off + 17];
      info.alpha = colorType === 4 || colorType === 6;
    } else if (type === 'acTL') info.animated = true; // APNG marker, always before the first IDAT
    else if (type === 'tRNS') info.alpha = true;
    else if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  return info;
}

const kb = (n) => `${(n / KB).toFixed(1)} КБ`;

const dataUrl = (bytes) => `data:image/png;base64,${bytesToB64(bytes)}`;

/* ---------- validation per badge kind ---------- */
const checks = () => {
  const items = [];
  const add = (level, text) => items.push({ level, text });
  return { items, ok: (t) => add('ok', t), err: (t) => add('err', t), warn: (t) => add('warn', t), failed: () => items.some((i) => i.level === 'err') };
};

function checkImage(c, info, { maxBytes, exact, minRecommended, square = true, requireAlpha = false, label = '' }) {
  if (!info.png) { c.err(`${label}Файл не PNG`); return; }
  c.ok(`${label}PNG`);
  info.animated ? c.err(`${label}Анимированный PNG (APNG) не допускается`) : c.ok(`${label}Без анимации`);
  if (exact) {
    info.width === exact && info.height === exact
      ? c.ok(`${label}Размер ${exact}×${exact}`)
      : c.err(`${label}Размер ${info.width}×${info.height}, нужен ${exact}×${exact}`);
  } else if (square) {
    info.width === info.height ? c.ok(`${label}Квадрат ${info.width}×${info.height}`) : c.err(`${label}Не квадрат: ${info.width}×${info.height}`);
  }
  if (minRecommended && info.width < minRecommended) c.warn(`${label}Рекомендуется от ${minRecommended}×${minRecommended}`);
  info.size <= maxBytes ? c.ok(`${label}${kb(info.size)} ≤ ${kb(maxBytes)}`) : c.err(`${label}${kb(info.size)} больше ${kb(maxBytes)}`);
  if (!info.alpha) (requireAlpha ? c.err : c.warn)(`${label}Нет прозрачного фона${requireAlpha ? '' : ' (рекомендуется)'}`);
}

const validators = {
  async drop(form, current) {
    const c = checks();
    const f = form.elements;
    const type = f.unlock.value;
    const title = f.title.value.trim();
    const eventName = f.event.value.trim();
    const typeName = { sub: 'за подписки/подарки', watch: 'за просмотр', top: 'Top Supporter' }[type];
    if (title.length > DROP_NAME_MAX) c.err(`Название длиннее ${DROP_NAME_MAX} символов`);

    if (type === 'top') {
      if (!TOP_SPOTS.includes(Number(f.top.value))) c.err('Мест в топе: 1, 3, 5 или 10');
    } else {
      const [min, max] = UNLOCK_RANGE[type];
      const n = Number(f.amount.value);
      if (!(Number.isInteger(n) && n >= min && n <= max)) c.err(`Количество: целое от ${min} до ${max}`);
    }

    const start = new Date(f.start.value), end = new Date(f.end.value);
    if (f.start.value && f.end.value) {
      const days = (end - start) / 86400000;
      if (days <= 0) c.err('Конец события должен быть позже начала');
      else if (days > DROP_MAX_DAYS) c.err(`Событие ${+days.toFixed(1)} дн. — максимум ${DROP_MAX_DAYS}`);
      else c.ok(`Длительность ${+days.toFixed(1)} дн. ≤ ${DROP_MAX_DAYS}`);
    }

    if (eventName) {
      const drops = current.filter((b) => b.kind === 'drop');
      const same = drops.filter((b) => b.event.name.toLowerCase() === eventName.toLowerCase());
      if (same.some((b) => b.unlock.type === type)) c.err(`В событии уже есть значок «${typeName}»`);
      if (type !== 'sub' && !same.some((b) => b.unlock.type === 'sub')) {
        c.err('Сначала добавьте обязательный значок за подписки/подарки');
      }
      if (same.length && (same[0].event.start !== f.start.value || same[0].event.end !== f.end.value)) {
        c.err('Даты должны совпадать с датами этого события');
      }
      if (!same.length && f.start.value && f.end.value) {
        const clash = drops.find((b) => new Date(b.event.start) < end && start < new Date(b.event.end));
        if (clash) c.err(`Пересекается с событием «${clash.event.name}» — одновременно идёт только одно событие`);
      }
    }

    const file = f.file.files[0];
    let info = null;
    if (file) {
      info = await inspectPng(file);
      checkImage(c, info, { maxBytes: DROP_MAX_BYTES, minRecommended: DROP_MIN_RECOMMENDED });
    }
    return { c, previews: info?.png ? [info.bytes] : [], build: () => buildDrop(form, info) };
  },

  async sub(form, current) {
    const c = checks();
    const f = form.elements;
    const months = Number(f.months.value);
    if (current.some((b) => b.kind === 'sub' && b.months === months)) c.err(`Значок за ${months} мес. уже есть`);
    const sizes = {};
    for (const s of [18, 36, 72]) {
      const file = f['a' + s].files[0];
      if (!file) continue;
      const info = await inspectPng(file);
      checkImage(c, info, { maxBytes: SUB_MAX_BYTES, exact: s, requireAlpha: true, label: `${s}px: ` });
      if (info.png) sizes[s] = info.bytes;
    }
    return { c, previews: [18, 36, 72].map((s) => sizes[s]).filter(Boolean), build: () => buildSub(form, sizes) };
  },

  async global(form) {
    const c = checks();
    const file = form.elements.file.files[0];
    let info = null;
    if (file) {
      info = await inspectPng(file);
      checkImage(c, info, { maxBytes: GLOBAL_MAX_BYTES });
      if (info.png && info.width < 18) c.err('Минимум 18×18');
    }
    return { c, previews: info?.png ? [info.bytes] : [], build: () => buildGlobal(form, info) };
  },
};

const newId = (kind) => `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function buildDrop(form, info) {
  const f = form.elements;
  const id = newId('drop');
  const path = `badges/files/${id}.png`;
  return {
    badge: {
      id, kind: 'drop', title: f.title.value.trim(),
      event: { name: f.event.value.trim(), start: f.start.value, end: f.end.value },
      unlock: { type: f.unlock.value, amount: Number(f.unlock.value === 'top' ? f.top.value : f.amount.value) },
      images: { x4: path }, createdAt: new Date().toISOString(),
    },
    files: [{ path, bytes: info.bytes }],
  };
}

function buildSub(form, sizes) {
  const months = Number(form.elements.months.value);
  const id = newId('sub');
  const files = [[18, 'x1'], [36, 'x2'], [72, 'x4']].map(([s, k]) => ({ k, path: `badges/files/${id}-${s}.png`, bytes: sizes[s] }));
  return {
    badge: {
      id, kind: 'sub', months, title: `Подписчик (${months} мес.)`,
      images: Object.fromEntries(files.map((x) => [x.k, x.path])), createdAt: new Date().toISOString(),
    },
    files,
  };
}

function buildGlobal(form, info) {
  const f = form.elements;
  const id = newId('global');
  const path = `badges/files/${id}.png`;
  return {
    badge: { id, kind: 'global', title: f.title.value.trim(), desc: f.desc.value.trim(), images: { x4: path }, createdAt: new Date().toISOString() },
    files: [{ path, bytes: info.bytes }],
  };
}

function renderCheck(form, result) {
  const box = $('.check', form);
  const ul = el('ul');
  for (const i of result.c.items) ul.append(el('li', { className: i.level, textContent: (i.level === 'ok' ? '✓ ' : i.level === 'err' ? '✕ ' : '! ') + i.text }));
  const prev = el('div', { className: 'previews' });
  for (const bytes of result.previews) {
    const src = dataUrl(bytes);
    // show at the real chat size (18px) and at the tooltip size
    prev.append(el('img', { src, width: 18, height: 18, alt: '18px' }), el('img', { src, width: 36, height: 36, alt: '36px' }), el('img', { src, width: 72, height: 72, alt: '72px' }));
  }
  box.replaceChildren(ul, result.previews.length ? prev : '');
}

/* ---------- admin dialog ---------- */
const dialog = $('#admin');
const status = (text, isErr = false) => { const s = $('#adminStatus'); s.textContent = text; s.classList.toggle('err', isErr); };

function renderAuth() {
  const authed = Boolean(token);
  $('#authBox').hidden = authed;
  $('#ownerBox').hidden = !authed;
  $('#repoLabel').textContent = repo.owner ? `${repo.owner}/${repo.name}` : '(укажите ниже)';
  $('#repoFields').hidden = repo.fixed;
  $('#repoOwner').value = repo.owner;
  $('#repoName').value = repo.name;
  $('#ownerLogin').textContent = store.get('tbc.login', '');
}

$('#openAdmin').onclick = () => { togglePopover(null); renderAuth(); status(''); dialog.showModal(); };
$('[data-close-dialog]').onclick = () => dialog.close();
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!repo.fixed) {
    repo.owner = $('#repoOwner').value.trim();
    repo.name = $('#repoName').value.trim();
    store.set('tbc.repo', { owner: repo.owner, name: repo.name });
  }
  const btn = e.submitter;
  btn.disabled = true;
  token = $('#tokenInput').value.trim();
  try {
    const r = await gh(repoPath());
    if (!r.permissions?.push) throw new Error('У токена нет права записи в репозиторий');
    const me = await gh('/user').catch(() => ({ login: repo.owner }));
    store.set('tbc.token', token);
    store.set('tbc.login', me.login);
    $('#tokenInput').value = '';
    status('');
    renderAuth();
    await loadManifest();
  } catch (err) {
    token = null;
    status(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#logoutBtn').onclick = () => { token = null; store.del('tbc.token'); store.del('tbc.login'); renderAuth(); };

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.upload').forEach((f) => { f.hidden = f.dataset.kind !== t.dataset.tab; });
  };
});

// drop: the amount control depends on the reward type
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
  const ev = manifest.badges.find((b) => b.kind === 'drop' && b.event.name.toLowerCase() === name);
  if (ev) { dropForm.elements.start.value = ev.event.start; dropForm.elements.end.value = ev.event.end; }
});
resetDropForm();

const subForm = $('#form-sub');
subForm.elements.months.replaceChildren(...SUB_MONTHS.map((m) => el('option', { value: m, textContent: `${m} мес.` })));

for (const form of document.querySelectorAll('.upload')) {
  const run = () => validators[form.dataset.kind](form, manifest.badges);
  form.addEventListener('change', async () => renderCheck(form, await run()));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    status('Проверка…');
    try {
      let badge;
      const saved = await updateManifest(() => `Add badge: ${badge.title}`, async (latest) => {
        // validate against the committed state, not a stale copy
        const result = await validators[form.dataset.kind](form, latest.badges);
        renderCheck(form, result);
        if (result.c.failed()) throw new Error('Исправьте ошибки выше');
        if (result.previews.length < (form.dataset.kind === 'sub' ? 3 : 1)) throw new Error('Выберите файл(ы) изображения');
        status('Сохранение в репозиторий…');
        const built = result.build();
        badge = built.badge;
        latest.badges.push(badge);
        return built.files;
      });
      for (const f of saved.files) if (f.path !== MANIFEST_PATH) freshImages.set(f.path, dataUrl(f.bytes));
      manifest = saved.manifest;
      form.reset();
      if (form === dropForm) resetDropForm();
      $('.check', form).replaceChildren();
      renderAll();
      status(`Значок «${badge.title}» добавлен. Для других зрителей появится через ~1 минуту.`);
    } catch (err) {
      status(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

function renderBadgeList() {
  const box = $('#badgeList');
  const events = new Set(manifest.badges.filter((b) => b.kind === 'drop').map((b) => b.event.name));
  $('#eventList').replaceChildren(...[...events].map((value) => el('option', { value })));
  box.replaceChildren(...(manifest.badges.length ? manifest.badges.map((b) => {
    const v = badgeView(b);
    const del = el('button', { className: 'btn danger', textContent: 'Удалить' });
    del.onclick = () => deleteBadge(b, del);
    return el('div', { className: 'badge-item' },
      el('img', { src: bigSrc(v.images), alt: '' }),
      el('div', { className: 'info' }, el('b', { textContent: v.title }), el('span', { textContent: b.kind === 'global' ? `Общий · ${v.desc}` : v.desc })),
      del);
  }) : [el('span', { className: 'empty', textContent: 'Значков пока нет' })]));
}

async function deleteBadge(b, btn) {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Точно удалить?';
    setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Удалить'; }, 3000);
    return;
  }
  btn.disabled = true;
  status('Удаление…');
  try {
    const saved = await updateManifest(() => `Remove badge: ${b.title}`, async (latest) => {
      const target = latest.badges.find((x) => x.id === b.id);
      if (!target) throw new Error('Значок уже удалён');
      if (target.kind === 'drop' && target.unlock.type === 'sub'
        && latest.badges.some((x) => x.kind === 'drop' && x.id !== target.id && x.event.name === target.event.name)) {
        throw new Error('Значок за подписки обязателен — сначала удалите остальные значки этого события');
      }
      latest.badges = latest.badges.filter((x) => x.id !== b.id);
      return Object.values(target.images).map((path) => ({ path, bytes: null }));
    });
    manifest = saved.manifest;
    renderAll();
    status(`Значок «${b.title}» удалён.`);
  } catch (err) {
    status(err.message, true);
    btn.disabled = false;
  }
}

/* ---------- boot ---------- */
applyTs();
renderAll();
renderMessages();
syncInput();
loadManifest();
addEventListener('focus', () => { if (!dialog.open) loadManifest(); });
