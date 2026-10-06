import { DurableObject } from 'cloudflare:workers';
import { ROLE_SETS, SUB_SETS, SLOT_OF_UPLOAD, IMAGE_KEYS, describe } from '../../rules.js';

const MAX_MESSAGES = 150;            // Twitch keeps roughly this many lines in the chat buffer
const MAX_TEXT = 500;                // Twitch chat message limit
// One script per nick (Latin or Cyrillic) + uniqueness by a confusable "skeleton", so "Аlpha" (Cyrillic А)
// can't impersonate "Alpha". The channel owner's nick is reserved for the admin key.
const NICK = /^(?:[A-Za-z0-9_]{3,25}|[А-Яа-яЁё0-9_]{3,25})$/u;
const CONFUSABLE = { а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', з: '3', ь: 'b', ч: '4', б: '6' };
const skeleton = (nick) => [...nick.toLowerCase()].map((ch) => CONFUSABLE[ch] ?? ch).join('')
  .replace(/0/g, 'o').replace(/[1l]/g, 'i').replace(/_/g, '');
const RESERVED = ['alkatrazzjr', 'admin', 'moderator', 'twitch'].map(skeleton);
// new nicks per IP (people may share an IP) and nick/color changes per browser key, per hour
const PROFILE_LIMIT = { windowMs: 3600_000, newPerIp: 30, changesPerKey: 20 };
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const RATE = { minGapMs: 300, windowMs: 30_000, maxInWindow: 20 }; // per IP, so new browser keys don't reset it

const sha256 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

// One shared chat room. Every socket authenticates with its browser key (and optionally the owner's admin key);
// nick + color are registered server-side per browser key, so nobody can post under someone else's nick.
export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (key_hash TEXT PRIMARY KEY, nick TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL)`);
    try { this.sql.exec('ALTER TABLE users ADD COLUMN skeleton TEXT'); } catch { /* already migrated */ }
    for (const u of this.sql.exec('SELECT key_hash, nick FROM users WHERE skeleton IS NULL').toArray()) {
      this.sql.exec('UPDATE users SET skeleton = ? WHERE key_hash = ?', skeleton(u.nick), u.key_hash);
    }
    // legacy rows could collide by skeleton; the lookup in profile() still enforces uniqueness for new nicks
    try { this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_skeleton ON users(skeleton)'); } catch { /* keep going */ }
    // persisted so limits survive hibernation; keyed by IP so rotating browser keys doesn't help
    this.sql.exec('CREATE TABLE IF NOT EXISTS events (ip_hash TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS events_ip ON events(ip_hash, kind, at)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, at INTEGER NOT NULL, key_hash TEXT NOT NULL, data TEXT NOT NULL)`);
    this.twitch = null;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const ipHash = await sha256(`${req.headers.get('CF-Connecting-IP') || ''}:${this.env.ADMIN_KEY}`);
    server.serializeAttachment({ keyHash: null, admin: false, ipHash, base: new URL(req.url).origin });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch { /* socket closed */ } }
  broadcast(msg) { const s = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { /* closed */ } } }
  user(keyHash) { return this.sql.exec('SELECT nick, color FROM users WHERE key_hash = ?', keyHash).toArray()[0] ?? null; }
  history() {
    return this.sql.exec('SELECT data FROM messages ORDER BY at').toArray().map((r) => JSON.parse(r.data));
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment();
    try {
      if (msg.type === 'hello') return await this.hello(ws, att, msg);
      if (!att.keyHash) return this.send(ws, { type: 'error', error: 'Нет ключа браузера' });
      if (msg.type === 'profile') return this.profile(ws, att, msg);
      if (msg.type === 'send') return await this.post(ws, att, msg);
      if (msg.type === 'delete' || msg.type === 'clear') {
        if (!att.admin) return this.send(ws, { type: 'error', error: 'Чат модерирует только владелец' });
        if (msg.type === 'clear') { this.sql.exec('DELETE FROM messages'); return this.broadcast({ type: 'clear' }); }
        this.sql.exec('DELETE FROM messages WHERE id = ?', String(msg.id));
        return this.broadcast({ type: 'delete', id: String(msg.id) });
      }
    } catch (err) {
      console.error(err);
      this.send(ws, { type: 'error', error: 'Ошибка сервера' });
    }
  }

  async hello(ws, att, msg) {
    const key = String(msg.key || '');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) return this.send(ws, { type: 'error', error: 'Неверный ключ браузера' });
    att.keyHash = await sha256(key);
    att.admin = Boolean(msg.adminKey && this.env.ADMIN_KEY) && (await sha256(String(msg.adminKey))) === (await sha256(this.env.ADMIN_KEY));
    ws.serializeAttachment(att);
    this.send(ws, { type: 'init', admin: att.admin, me: this.user(att.keyHash), messages: this.history() });
  }

  profile(ws, att, msg) {
    const nick = String(msg.nick || '').trim();
    const color = String(msg.color || '');
    if (!NICK.test(nick)) return this.send(ws, { type: 'profile', error: 'Ник: 3–25 символов — латиница или кириллица (не вперемешку), цифры и _' });
    if (!COLOR.test(color)) return this.send(ws, { type: 'profile', error: 'Неверный цвет' });
    const skel = skeleton(nick);
    if (!att.admin && RESERVED.includes(skel)) return this.send(ws, { type: 'profile', error: `Ник «${nick}» зарезервирован` });
    const owner = this.sql.exec('SELECT key_hash FROM users WHERE skeleton = ?', skel).toArray()[0];
    if (owner && owner.key_hash !== att.keyHash) return this.send(ws, { type: 'profile', error: `Ник «${nick}» уже занят` });
    const current = this.user(att.keyHash);
    if (current?.nick === nick && current.color === color.toUpperCase()) return this.send(ws, { type: 'profile', me: current });
    const limitedNow = current
      ? this.limited(att.keyHash, 'profile-change', PROFILE_LIMIT.windowMs, PROFILE_LIMIT.changesPerKey)
      : this.limited(att.ipHash, 'profile-new', PROFILE_LIMIT.windowMs, PROFILE_LIMIT.newPerIp);
    if (!att.admin && limitedNow) return this.send(ws, { type: 'profile', error: 'Слишком много смен ника, попробуйте позже' });
    this.sql.exec(`INSERT INTO users (key_hash, nick, color, skeleton) VALUES (?, ?, ?, ?)
      ON CONFLICT(key_hash) DO UPDATE SET nick = excluded.nick, color = excluded.color, skeleton = excluded.skeleton`,
    att.keyHash, nick, color.toUpperCase(), skel);
    this.send(ws, { type: 'profile', me: this.user(att.keyHash) });
  }

  // Records the event unless `who` (IP or browser-key hash) already hit `max` events of this kind within `windowMs`.
  limited(ipHash, kind, windowMs, max, minGapMs = 0) {
    const now = Date.now();
    this.sql.exec('DELETE FROM events WHERE at < ?', now - 3600_000);
    const [{ n, last }] = this.sql.exec('SELECT COUNT(*) AS n, MAX(at) AS last FROM events WHERE ip_hash = ? AND kind = ? AND at > ?',
      ipHash, kind, now - windowMs).toArray();
    if (n >= max || (minGapMs && last && now - last < minGapMs)) return true;
    this.sql.exec('INSERT INTO events (ip_hash, kind, at) VALUES (?, ?, ?)', ipHash, kind, now);
    return false;
  }

  async post(ws, att, msg) {
    const me = this.user(att.keyHash);
    if (!me) return this.send(ws, { type: 'error', error: 'Сначала выберите ник' });
    const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) return;
    if (!att.admin && this.limited(att.ipHash, 'msg', RATE.windowMs, RATE.maxInWindow, RATE.minGapMs)) {
      return this.send(ws, { type: 'error', error: 'Слишком быстро, подождите' });
    }
    const m = {
      id: crypto.randomUUID(), t: Date.now(), nick: me.nick, color: me.color, text,
      badges: await this.resolveBadges(msg.badges || {}, att.base),
    };
    this.sql.exec('INSERT INTO messages (id, at, key_hash, data) VALUES (?, ?, ?, ?)', m.id, m.t, att.keyHash, JSON.stringify(m));
    this.sql.exec('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY at DESC LIMIT ?)', MAX_MESSAGES);
    this.broadcast({ type: 'msg', m });
  }

  async twitchSets() {
    if (this.twitch && Date.now() - this.twitch.at < 6 * 3600_000) return this.twitch.sets;
    const res = await fetch('https://api.ivr.fi/v2/twitch/badges/global', { headers: { 'User-Agent': 'twitch-badge-chat' } });
    if (!res.ok) return this.twitch?.sets ?? [];
    this.twitch = { at: Date.now(), sets: await res.json() };
    return this.twitch.sets;
  }

  // Badges are resolved on the server from ids, so a message can only carry real Twitch / uploaded badges,
  // at most one per slot (role, subscription, other) — the same 3 slots Twitch has.
  async resolveBadges(ids, base) {
    const out = [];
    for (const slot of ['role', 'sub', 'other']) {
      const id = typeof ids[slot] === 'string' ? ids[slot] : '';
      if (!id) continue;
      if (id.startsWith('tw:')) {
        const [, set, version] = id.split(':');
        const fits = slot === 'role' ? ROLE_SETS.includes(set)
          : slot === 'sub' ? SUB_SETS.includes(set)
            : !ROLE_SETS.includes(set) && !SUB_SETS.includes(set);
        if (!fits) continue;
        const v = (await this.twitchSets()).find((s) => s.set_id === set)?.versions.find((x) => x.id === version);
        if (v) {
          out.push({
            title: v.title,
            desc: describe({ kind: 'twitch', title: v.title, desc: (v.description || '').trim() }),
            images: { x1: v.image_url_1x, x2: v.image_url_2x, x4: v.image_url_4x },
          });
        }
      } else if (slot !== 'role') {
        const row = await this.env.DB.prepare('SELECT id, data FROM badges WHERE id = ?').bind(id).first();
        if (!row) continue;
        const data = JSON.parse(row.data);
        if (SLOT_OF_UPLOAD[data.kind] !== slot) continue;
        out.push({
          title: data.title, desc: describe(data),
          images: Object.fromEntries(IMAGE_KEYS[data.kind].map((k) => [k, `${base}/img/${row.id}/${k}`])),
        });
      }
    }
    return out;
  }

  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch { /* already closed */ } }
}
