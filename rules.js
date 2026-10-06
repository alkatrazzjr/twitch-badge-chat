// Badge rules shared by the site (live checks) and the Worker (authoritative checks).
// Sources: help.twitch.tv/s/article/creator-badge-rewards, help.twitch.tv/s/article/subscriber-badge-guide

const KB = 1024;
export const LIMITS = {
  dropMaxBytes: 25 * KB,       // "maximum 25kb file size"
  dropMinRecommended: 120,     // "Recommended dimensions are at least 120x120 pixels"
  dropMaxDays: 28,             // "Events cannot exceed 28 days"
  dropNameMax: 25,             // "Badge Name: Up to 25 characters"
  subMaxBytes: 25 * KB,        // "The file size cannot exceed 25kb"
  globalMaxBytes: 100 * KB,    // not a Twitch upload: imitation of global badges
  eventNameMax: 60,
  globalTitleMax: 40,
  globalDescMax: 80,
};
export const UNLOCK_RANGE = { sub: [1, 100], watch: [1, 24] }; // subscriptions 1–100, watch time up to 24 h
export const TOP_SPOTS = [1, 3, 5, 10];
export const SUB_MONTHS = [1, 2, 3, 6, 9, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72, 78, 84, 90, 96, 102, 108, 114, 120];
export const IMAGE_KEYS = { drop: ['x4'], sub: ['x1', 'x2', 'x4'], global: ['x4'] };
const SUB_SIZES = { x1: 18, x2: 36, x4: 72 };

export function inspectPng(bytes) {
  const info = { size: bytes.length, png: false, width: 0, height: 0, animated: false, alpha: false };
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !sig.every((b, i) => bytes[i] === b)) return info;
  info.png = true;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = 8; off + 8 <= bytes.length;) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (type === 'IHDR') {
      info.width = dv.getUint32(off + 8);
      info.height = dv.getUint32(off + 12);
      info.alpha = bytes[off + 17] === 4 || bytes[off + 17] === 6;
    } else if (type === 'acTL') info.animated = true; // APNG marker, always before the first IDAT
    else if (type === 'tRNS') info.alpha = true;
    else if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  return info;
}

const kb = (n) => `${(n / KB).toFixed(1)} КБ`;

function checkImage(c, bytes, { maxBytes, exact, minRecommended, requireAlpha = false, label = '' }) {
  const info = inspectPng(bytes);
  if (!info.png) { c.err(`${label}Файл не PNG`); return; }
  c.ok(`${label}PNG`);
  info.animated ? c.err(`${label}Анимированный PNG (APNG) не допускается`) : c.ok(`${label}Без анимации`);
  if (exact) {
    info.width === exact && info.height === exact
      ? c.ok(`${label}Размер ${exact}×${exact}`)
      : c.err(`${label}Размер ${info.width}×${info.height}, нужен ${exact}×${exact}`);
  } else {
    info.width === info.height ? c.ok(`${label}Квадрат ${info.width}×${info.height}`) : c.err(`${label}Не квадрат: ${info.width}×${info.height}`);
    if (info.width < 18) c.err(`${label}Минимум 18×18`);
  }
  if (minRecommended && info.width < minRecommended) c.warn(`${label}Рекомендуется от ${minRecommended}×${minRecommended}`);
  info.size <= maxBytes ? c.ok(`${label}${kb(info.size)} ≤ ${kb(maxBytes)}`) : c.err(`${label}${kb(info.size)} больше ${kb(maxBytes)}`);
  if (!info.alpha) (requireAlpha ? c.err : c.warn)(`${label}Нет прозрачного фона${requireAlpha ? '' : ' (рекомендуется)'}`);
}

const sameEvent = (existing, name) => existing.find((b) => b.kind === 'drop' && b.event.name.toLowerCase() === name.toLowerCase());
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Validates a badge against Twitch rules and the uploader's existing badges (one category = one channel).
 * input: { kind, title, desc, months, event: { name, start, end }, unlock: { type, amount }, images: { x1|x2|x4: Uint8Array } }
 * Missing images are reported only when `requireImages` (the live form check runs before files are picked).
 * Returns { items: [{ level, text }], failed, badge } where badge is the normalized, whitelisted metadata.
 */
export function validateBadge(input, existing, { requireImages = true } = {}) {
  const items = [];
  const c = {
    ok: (text) => items.push({ level: 'ok', text }),
    warn: (text) => items.push({ level: 'warn', text }),
    err: (text) => items.push({ level: 'err', text }),
  };
  const kind = input?.kind;
  const images = input?.images || {};
  let badge = null;

  if (!IMAGE_KEYS[kind]) {
    c.err('Неизвестный тип значка');
  } else if (kind === 'drop') {
    const title = str(input.title);
    const name = str(input.event?.name);
    const start = str(input.event?.start), end = str(input.event?.end);
    const type = input.unlock?.type;
    const amount = Number(input.unlock?.amount);
    if (!title) c.err('Укажите название значка');
    if (title.length > LIMITS.dropNameMax) c.err(`Название длиннее ${LIMITS.dropNameMax} символов`);
    if (!name || name.length > LIMITS.eventNameMax) c.err(`Название события: 1–${LIMITS.eventNameMax} символов`);

    if (type === 'top') {
      if (!TOP_SPOTS.includes(amount)) c.err('Мест в топе: 1, 3, 5 или 10');
    } else if (UNLOCK_RANGE[type]) {
      const [min, max] = UNLOCK_RANGE[type];
      if (!(Number.isInteger(amount) && amount >= min && amount <= max)) c.err(`Количество: целое от ${min} до ${max}`);
    } else c.err('Неизвестный способ получения');

    if (!DT.test(start) || !DT.test(end)) c.err('Укажите начало и конец события');
    else {
      const days = (Date.parse(end) - Date.parse(start)) / 86400000;
      if (days <= 0) c.err('Конец события должен быть позже начала');
      else if (days > LIMITS.dropMaxDays) c.err(`Событие ${+days.toFixed(1)} дн. — максимум ${LIMITS.dropMaxDays}`);
      else c.ok(`Длительность ${+days.toFixed(1)} дн. ≤ ${LIMITS.dropMaxDays}`);
    }

    if (name) {
      const drops = existing.filter((b) => b.kind === 'drop');
      const same = drops.filter((b) => b.event.name.toLowerCase() === name.toLowerCase());
      const typeName = { sub: 'за подписки/подарки', watch: 'за просмотр', top: 'Top Supporter' }[type];
      if (same.some((b) => b.unlock.type === type)) c.err(`В событии уже есть значок «${typeName}»`);
      if (type !== 'sub' && !same.some((b) => b.unlock.type === 'sub')) c.err('Сначала добавьте обязательный значок за подписки/подарки');
      if (same.length && (same[0].event.start !== start || same[0].event.end !== end)) c.err('Даты должны совпадать с датами этого события');
      if (!same.length && DT.test(start) && DT.test(end)) {
        const clash = drops.find((b) => Date.parse(b.event.start) < Date.parse(end) && Date.parse(start) < Date.parse(b.event.end));
        if (clash) c.err(`Пересекается с событием «${clash.event.name}» — одновременно идёт только одно событие`);
      }
    }
    if (images.x4) checkImage(c, images.x4, { maxBytes: LIMITS.dropMaxBytes, minRecommended: LIMITS.dropMinRecommended });
    badge = { kind, title, event: { name: sameEvent(existing, name)?.event.name ?? name, start, end }, unlock: { type, amount } };
  } else if (kind === 'sub') {
    const months = Number(input.months);
    if (!SUB_MONTHS.includes(months)) c.err('Неверный стаж подписки');
    if (existing.some((b) => b.kind === 'sub' && b.months === months)) c.err(`Значок за ${months} мес. уже есть`);
    for (const k of IMAGE_KEYS.sub) {
      if (images[k]) checkImage(c, images[k], { maxBytes: LIMITS.subMaxBytes, exact: SUB_SIZES[k], requireAlpha: true, label: `${SUB_SIZES[k]}px: ` });
    }
    badge = { kind, months, title: `Подписчик (${months} мес.)` };
  } else {
    const title = str(input.title), desc = str(input.desc);
    if (!title || title.length > LIMITS.globalTitleMax) c.err(`Название: 1–${LIMITS.globalTitleMax} символов`);
    if (desc.length > LIMITS.globalDescMax) c.err(`Описание длиннее ${LIMITS.globalDescMax} символов`);
    if (images.x4) checkImage(c, images.x4, { maxBytes: LIMITS.globalMaxBytes });
    badge = { kind, title, desc };
  }

  if (requireImages && IMAGE_KEYS[kind]?.some((k) => !images[k])) c.err('Выберите файл(ы) изображения');
  return { items, failed: items.some((i) => i.level === 'err'), badge };
}

// Badge whose removal would leave an event without its required sub/gift reward.
export function deleteBlocker(target, existing) {
  if (target.kind !== 'drop' || target.unlock.type !== 'sub') return null;
  return existing.some((b) => b.kind === 'drop' && b.id !== target.id && b.event.name === target.event.name)
    ? 'Значок за подписки обязателен — сначала удалите остальные значки этого события'
    : null;
}
