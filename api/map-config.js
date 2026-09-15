// File: /api/map-config.js
//
// Публична конфигурация за картата.
//
// От 2026 г. CARTO изисква API ключ за растерните си подложки - без него всяка
// плочка идва с воден знак "API KEY REQUIRED". Ключът НЕ се пише в index.html,
// защото хранилището е публично, а CARTO изрично забранява споделянето му.
// Той живее в променливата на средата CARTO_BASEMAPS_KEY във Vercel.
//
// ВАЖНО: ключът за подложката по природа достига браузъра (плочките се теглят
// от клиента), така че истинската защита е ограничаването му по домейн в
// таблото на CARTO, а не криенето. Тази крайна точка само го пази извън git.

// Допускаме само безопасни символи, за да не може грешна стойност в средата
// да счупи URL адреса на плочките.
const KEY_PATTERN = /^[A-Za-z0-9_\-.]{8,200}$/;

export default function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Конфигурацията рядко се променя - кратко кеширане спестява заявка при всяко зареждане.
  response.setHeader('Cache-Control', 'public, max-age=300');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Методът не е разрешен.' });
  }

  const rawKey = (process.env.CARTO_BASEMAPS_KEY || '').trim();
  const cartoKey = KEY_PATTERN.test(rawKey) ? rawKey : null;

  if (rawKey && !cartoKey) {
    console.error('[КАРТА] CARTO_BASEMAPS_KEY е зададен, но има невалиден формат - използва се резервната подложка.');
  }

  return response.status(200).json({ cartoKey });
}
