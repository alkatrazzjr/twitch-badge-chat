// Nick registry in D1, shared by the HTTP API (categories belong to a user) and the chat Durable Object.

// One script per nick (Latin or Cyrillic) + uniqueness by a confusable "skeleton", so "Аlpha" (Cyrillic А)
// can't impersonate "Alpha". The channel owner's nick is reserved for the admin key.
export const NICK = /^(?:[A-Za-z0-9_]{3,25}|[А-Яа-яЁё0-9_]{3,25})$/u;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const CONFUSABLE = { а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', з: '3', ь: 'b', ч: '4', б: '6' };
export const skeleton = (nick) => [...nick.toLowerCase()].map((ch) => CONFUSABLE[ch] ?? ch).join('')
  .replace(/0/g, 'o').replace(/[1l]/g, 'i').replace(/_/g, '');
const RESERVED = ['alkatrazzjr', 'admin', 'moderator', 'twitch'].map(skeleton);

export const sha256 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

export const userByKey = (db, keyHash) => db.prepare('SELECT id, nick, color FROM users WHERE key_hash = ?').bind(keyHash).first();

// Returns { user } or { error }.
export async function registerNick(db, keyHash, nickRaw, colorRaw, admin) {
  const nick = String(nickRaw || '').trim();
  const color = String(colorRaw || '').toUpperCase();
  if (!NICK.test(nick)) return { error: 'Ник: 3–25 символов — латиница или кириллица (не вперемешку), цифры и _' };
  if (!COLOR.test(color)) return { error: 'Неверный цвет' };
  const skel = skeleton(nick);
  if (!admin && RESERVED.includes(skel)) return { error: `Ник «${nick}» зарезервирован` };
  const owner = await db.prepare('SELECT key_hash FROM users WHERE skeleton = ?').bind(skel).first();
  if (owner && owner.key_hash !== keyHash) return { error: `Ник «${nick}» уже занят` };
  await db.prepare(`INSERT INTO users (id, key_hash, nick, skeleton, color, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET nick = excluded.nick, skeleton = excluded.skeleton, color = excluded.color`)
    .bind(crypto.randomUUID().replaceAll('-', '').slice(0, 16), keyHash, nick, skel, color, new Date().toISOString()).run();
  return { user: await userByKey(db, keyHash) };
}
