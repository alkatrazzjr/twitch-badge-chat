import { validateBadge, deleteBlocker, IMAGE_KEYS } from '../../rules.js';

const MAX_BODY = 400 * 1024;
const MAX_BADGES_PER_CATEGORY = 60;
const MAX_CATEGORIES_PER_IP = 5;
const MAX_UPLOADS_PER_IP_PER_HOUR = 60;
const CATEGORY_NAME = /^[^\p{C}]{2,25}$/u;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sha256 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');
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
  const category = keyHash
    ? await env.DB.prepare('SELECT id, name FROM categories WHERE key_hash = ?').bind(keyHash).first()
    : null;
  const ipHash = await sha256(`${req.headers.get('CF-Connecting-IP') || ''}:${env.ADMIN_KEY}`);
  return { admin, keyHash, category, ipHash };
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

async function canManage(env, who, categoryId) {
  if (who.admin) return true;
  return Boolean(who.category && who.category.id === categoryId);
}

const routes = {
  async 'GET /state'(req, env, who, base) {
    const [cats, badges] = await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM categories ORDER BY created_at'),
      env.DB.prepare('SELECT id, category_id, data, created_at FROM badges ORDER BY created_at'),
    ]);
    return { categories: cats.results, badges: badges.results.map((r) => badgeJson(r, base)) };
  },

  async 'GET /me'(req, env, who) {
    return { category: who.category, admin: who.admin };
  },

  async 'PUT /me'(req, env, who) {
    if (!who.keyHash) throw new HttpError(401, 'Нет ключа браузера');
    const name = String((await readJson(req)).name || '').trim();
    if (!CATEGORY_NAME.test(name)) throw new HttpError(400, 'Название категории: 2–25 символов');
    const taken = await env.DB.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first();
    if (taken && taken.id !== who.category?.id) throw new HttpError(409, 'Такая категория уже есть');
    if (who.category) {
      await env.DB.prepare('UPDATE categories SET name = ? WHERE id = ?').bind(name, who.category.id).run();
      return { category: { id: who.category.id, name }, admin: who.admin };
    }
    if (!who.admin) {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM categories WHERE ip_hash = ?').bind(who.ipHash).first('n');
      if (n >= MAX_CATEGORIES_PER_IP) throw new HttpError(429, 'С этого IP создано слишком много категорий');
    }
    const id = newId();
    await env.DB.prepare('INSERT INTO categories (id, name, key_hash, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, who.keyHash, who.ipHash, new Date().toISOString()).run();
    return { category: { id, name }, admin: who.admin };
  },

  async 'POST /badges'(req, env, who, base) {
    if (!who.category) throw new HttpError(403, 'Сначала создайте свою категорию');
    if (!who.admin) {
      const hourAgo = Date.now() - 3600_000;
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM uploads WHERE ip_hash = ? AND at > ?').bind(who.ipHash, hourAgo).first('n');
      if (n >= MAX_UPLOADS_PER_IP_PER_HOUR) throw new HttpError(429, 'Слишком много загрузок, попробуйте позже');
    }
    const body = await readJson(req);
    const existing = await categoryBadges(env, who.category.id);
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
      env.DB.prepare('INSERT INTO badges (id, category_id, data, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, who.category.id, JSON.stringify(result.badge), now),
      ...Object.entries(images).map(([k, bytes]) => env.DB.prepare('INSERT INTO images (badge_id, key, bytes) VALUES (?, ?, ?)').bind(id, k, bytes)),
      env.DB.prepare('INSERT INTO uploads (ip_hash, at) VALUES (?, ?)').bind(who.ipHash, Date.now()),
      env.DB.prepare('DELETE FROM uploads WHERE at < ?').bind(Date.now() - 86400_000),
    ]);
    return badgeJson({ id, category_id: who.category.id, data: JSON.stringify(result.badge), created_at: now }, base);
  },

  async 'DELETE /badges/:id'(req, env, who, base, id) {
    const row = await env.DB.prepare('SELECT id, category_id, data FROM badges WHERE id = ?').bind(id).first();
    if (!row) throw new HttpError(404, 'Значок не найден');
    if (!(await canManage(env, who, row.category_id))) throw new HttpError(403, 'Удалять можно только свои значки');
    const blocker = deleteBlocker({ id, ...JSON.parse(row.data) }, await categoryBadges(env, row.category_id));
    if (blocker) throw new HttpError(409, blocker);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM images WHERE badge_id = ?').bind(id),
      env.DB.prepare('DELETE FROM badges WHERE id = ?').bind(id),
    ]);
    return { ok: true };
  },

  async 'DELETE /categories/:id'(req, env, who, base, id) {
    if (!(await canManage(env, who, id))) throw new HttpError(403, 'Удалять можно только свою категорию');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM images WHERE badge_id IN (SELECT id FROM badges WHERE category_id = ?)').bind(id),
      env.DB.prepare('DELETE FROM badges WHERE category_id = ?').bind(id),
      env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id),
    ]);
    return { ok: true };
  },
};

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
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

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
