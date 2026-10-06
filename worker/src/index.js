import { validateBadge, deleteBlocker, IMAGE_KEYS } from '../../rules.js';
import { sha256, userByKey } from './users.js';

export { ChatRoom } from './chat.js';

const MAX_BODY = 400 * 1024;
const MAX_BADGES_PER_CATEGORY = 60;
const MAX_CATEGORIES_PER_USER = 20;
const LIMITS = { uploadsPerHour: 120, categoriesPerHour: 20 }; // per IP
const CATEGORY_NAME = /^[^\p{C}]{1,25}$/u;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);
const b64ToBytes = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

function cors(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGINS.split(',');
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Key, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function identify(req, env) {
  const key = req.headers.get('X-Key') || '';
  const adminKey = req.headers.get('X-Admin-Key') || '';
  // compare digests so the check does not leak the admin key through timing
  const admin = Boolean(adminKey && env.ADMIN_KEY) && (await sha256(adminKey)) === (await sha256(env.ADMIN_KEY));
  const keyHash = /^[A-Za-z0-9_-]{32,128}$/.test(key) ? await sha256(key) : null;
  const user = keyHash ? await userByKey(env.DB, keyHash) : null; // nick registered through the chat
  const ipHash = await sha256(`${req.headers.get('CF-Connecting-IP') || ''}:${env.ADMIN_KEY}`);
  return { admin, keyHash, user, ipHash };
}

const badgeJson = (row, base) => {
  const data = JSON.parse(row.data);
  const images = Object.fromEntries(IMAGE_KEYS[data.kind].map((k) => [k, `${base}/img/${row.id}/${k}`]));
  return { id: row.id, categoryId: row.category_id, createdAt: row.created_at, ...data, images };
};

async function categoryBadges(env, categoryId) {
  const { results } = await env.DB.prepare('SELECT id, data FROM badges WHERE category_id = ?').bind(categoryId).all();
  return results.map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Неверный JSON'); }
}

// A category is managed by its owner (the user who created it) or the site owner.
async function managedCategory(env, who, id) {
  const cat = await env.DB.prepare('SELECT id, owner_id, name FROM categories WHERE id = ?').bind(String(id)).first();
  if (!cat) throw new HttpError(404, 'Категория не найдена');
  if (!who.admin && cat.owner_id !== who.user?.id) throw new HttpError(403, 'Изменять можно только свои категории');
  return cat;
}

async function limited(env, ipHash, kind, max) {
  const now = Date.now();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE ip_hash = ? AND kind = ? AND at > ?').bind(ipHash, kind, now - 3600_000).first('n');
  if (n >= max) return true;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO events (ip_hash, kind, at) VALUES (?, ?, ?)').bind(ipHash, kind, now),
    env.DB.prepare('DELETE FROM events WHERE at < ?').bind(now - 3600_000),
  ]);
  return false;
}

function categoryName(body) {
  const name = String(body.name || '').trim();
  if (!CATEGORY_NAME.test(name)) throw new HttpError(400, 'Название категории: 1–25 символов');
  return name;
}

const deleteCategoryStatements = (env, id) => [
  env.DB.prepare('DELETE FROM images WHERE badge_id IN (SELECT id FROM badges WHERE category_id = ?)').bind(id),
  env.DB.prepare('DELETE FROM badges WHERE category_id = ?').bind(id),
  env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id),
];

const routes = {
  // owners (nick + color) with their categories and badges: the "nick → categories → badges" tree
  async 'GET /state'(req, env, who, base) {
    const [owners, cats, badges] = await env.DB.batch([
      env.DB.prepare('SELECT DISTINCT u.id, u.nick, u.color FROM users u JOIN categories c ON c.owner_id = u.id ORDER BY u.nick COLLATE NOCASE'),
      env.DB.prepare('SELECT id, owner_id, name FROM categories ORDER BY created_at'),
      env.DB.prepare('SELECT id, category_id, data, created_at FROM badges ORDER BY created_at'),
    ]);
    return {
      owners: owners.results,
      categories: cats.results.map((c) => ({ id: c.id, ownerId: c.owner_id, name: c.name })),
      badges: badges.results.map((r) => badgeJson(r, base)),
    };
  },

  async 'GET /me'(req, env, who) {
    return { user: who.user, admin: who.admin };
  },

  async 'POST /categories'(req, env, who) {
    if (!who.user) throw new HttpError(403, 'Сначала выберите ник в «Имя в чате»');
    const name = categoryName(await readJson(req));
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM categories WHERE owner_id = ?').bind(who.user.id).first('n');
    if (n >= MAX_CATEGORIES_PER_USER) throw new HttpError(400, `Максимум ${MAX_CATEGORIES_PER_USER} категорий`);
    if (!who.admin && await limited(env, who.ipHash, 'category', LIMITS.categoriesPerHour)) throw new HttpError(429, 'Слишком много новых категорий, попробуйте позже');
    const id = newId();
    try {
      await env.DB.prepare('INSERT INTO categories (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').bind(id, who.user.id, name, new Date().toISOString()).run();
    } catch { throw new HttpError(409, 'У вас уже есть такая категория'); }
    return { id, ownerId: who.user.id, name };
  },

  async 'PUT /categories/:id'(req, env, who, base, id) {
    const cat = await managedCategory(env, who, id);
    const name = categoryName(await readJson(req));
    try {
      await env.DB.prepare('UPDATE categories SET name = ? WHERE id = ?').bind(name, cat.id).run();
    } catch { throw new HttpError(409, 'Такая категория уже есть'); }
    return { ok: true };
  },

  async 'DELETE /categories/:id'(req, env, who, base, id) {
    const cat = await managedCategory(env, who, id);
    await env.DB.batch(deleteCategoryStatements(env, cat.id));
    return { ok: true };
  },

  // every category of one user (their whole branch in the tree)
  async 'DELETE /owners/:id'(req, env, who, base, id) {
    if (!who.admin && who.user?.id !== id) throw new HttpError(403, 'Удалять можно только свои категории');
    const { results } = await env.DB.prepare('SELECT id FROM categories WHERE owner_id = ?').bind(id).all();
    if (results.length) await env.DB.batch(results.flatMap((c) => deleteCategoryStatements(env, c.id)));
    return { ok: true };
  },

  async 'POST /badges'(req, env, who, base) {
    const body = await readJson(req);
    const cat = await managedCategory(env, who, body.categoryId);
    if (!who.admin && await limited(env, who.ipHash, 'upload', LIMITS.uploadsPerHour)) throw new HttpError(429, 'Слишком много загрузок, попробуйте позже');
    const existing = await categoryBadges(env, cat.id);
    if (existing.length >= MAX_BADGES_PER_CATEGORY) throw new HttpError(400, `Максимум ${MAX_BADGES_PER_CATEGORY} значков в категории`);
    const images = {};
    for (const k of IMAGE_KEYS[body.kind] || []) {
      if (typeof body.images?.[k] !== 'string') continue;
      try { images[k] = b64ToBytes(body.images[k]); } catch { throw new HttpError(400, 'Неверное изображение'); }
    }
    const result = validateBadge({ ...body, images }, existing);
    if (result.failed) throw new HttpError(400, result.items.filter((i) => i.level === 'err').map((i) => i.text).join('; '));

    const id = newId();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO badges (id, category_id, data, created_at) VALUES (?, ?, ?, ?)').bind(id, cat.id, JSON.stringify(result.badge), now),
      ...Object.entries(images).map(([k, bytes]) => env.DB.prepare('INSERT INTO images (badge_id, key, bytes) VALUES (?, ?, ?)').bind(id, k, bytes)),
    ]);
    return badgeJson({ id, category_id: cat.id, data: JSON.stringify(result.badge), created_at: now }, base);
  },

  async 'DELETE /badges/:id'(req, env, who, base, id) {
    const row = await env.DB.prepare('SELECT id, category_id, data FROM badges WHERE id = ?').bind(id).first();
    if (!row) throw new HttpError(404, 'Значок не найден');
    await managedCategory(env, who, row.category_id);
    const blocker = deleteBlocker({ id, ...JSON.parse(row.data) }, await categoryBadges(env, row.category_id));
    if (blocker) throw new HttpError(409, blocker);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM images WHERE badge_id = ?').bind(id),
      env.DB.prepare('DELETE FROM badges WHERE id = ?').bind(id),
    ]);
    return { ok: true };
  },
};

// Twitch global badges (roles, bits, sub defaults, event badges) via the public IVR mirror of Helix
// /chat/badges/global, trimmed and cached at the edge for a day.
async function twitchBadges(req, ctx, headers) {
  const cacheKey = new Request('https://cache.internal/twitch-global-badges-v1');
  let res = await caches.default.match(cacheKey);
  if (!res) {
    const upstream = await fetch('https://api.ivr.fi/v2/twitch/badges/global', { headers: { 'User-Agent': 'twitch-badge-chat' } });
    if (!upstream.ok) return Response.json({ error: 'Значки Twitch недоступны' }, { status: 502, headers });
    const sets = (await upstream.json()).map((s) => ({
      set: s.set_id,
      versions: s.versions.map((v) => ({
        id: v.id, title: v.title, desc: (v.description || '').trim(),
        x1: v.image_url_1x, x2: v.image_url_2x, x4: v.image_url_4x,
      })),
    }));
    res = Response.json(sets, { headers: { 'Cache-Control': 'public, max-age=86400' } });
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  }
  return new Response(res.body, { headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
}

async function image(env, id, key) {
  const row = await env.DB.prepare('SELECT bytes FROM images WHERE badge_id = ? AND key = ?').bind(id, key).first();
  if (!row) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(row.bytes), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable', // ids are never reused
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const headers = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname === '/twitch' && req.method === 'GET') return twitchBadges(req, ctx, headers);
    // the shared chat lives in a single Durable Object; it authenticates sockets itself
    if (url.pathname === '/chat') return env.CHAT.get(env.CHAT.idFromName('main')).fetch(req);

    const img = url.pathname.match(/^\/img\/([a-z0-9]+)\/(x[124])$/);
    if (img && req.method === 'GET') return image(env, img[1], img[2]);

    const [, first, param] = url.pathname.match(/^\/([a-z]+)(?:\/([a-z0-9]+))?\/?$/) || [];
    const handler = routes[`${req.method} /${first}${param ? '/:id' : ''}`];
    try {
      if (!handler) throw new HttpError(404, 'Not found');
      const who = await identify(req, env);
      const result = await handler(req, env, who, url.origin, param);
      return Response.json(result, { headers: { ...headers, 'Cache-Control': 'no-store' } });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return Response.json({ error: status === 500 ? 'Ошибка сервера' : err.message }, { status, headers });
    }
  },
};
