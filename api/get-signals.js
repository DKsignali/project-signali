// File: /api/get-signals.js
import { createClient } from '@supabase/supabase-js';

// Максимален брой сигнали в един отговор (най-новите).
const MAX_SIGNALS = 500;

// Публичните полета на сигнала. image_url НЕ е тук: снимките се пазят като
// base64 в самата колона (стотици килобайта всяка), а регистърът и картата
// не ги показват - включването им караше всеки посетител да тегли всички
// снимки без причина.
const PUBLIC_FIELDS = 'id, created_at, updated_at, corrected_text, location, assigned_institution, responsible_authority, assigned_enterprise, priority, status, latitude, longitude, votes_still_there, votes_fixed';

export default async function handler(request, response) {
  // Разрешаваме достъп (CORS)
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 🎯 Предотвратяване на кеширането на ниво браузър и мрежа
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Методът не е разрешен.' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    // Търсене на ЕДИН сигнал по номер (?id=123). Нужно е, защото регистърът
    // връща само последните MAX_SIGNALS - без тази опция проследяването на
    // по-стар сигнал би отговаряло "не съществува".
    // responsible_authority = компетентният орган (To), assigned_enterprise =
    // изпълнителят (Cc). Старите сигнали имат NULL в тях - фронтендът пада
    // обратно към assigned_institution.
    const rawId = request.query && request.query.id;
    if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
      const signalId = Number.parseInt(String(rawId).trim(), 10);
      if (!Number.isSafeInteger(signalId) || signalId <= 0) {
        return response.status(400).json({ success: false, error: 'Невалиден номер на сигнал.' });
      }

      const { data: one, error: oneError } = await supabase
        .from('signals')
        .select(PUBLIC_FIELDS)
        .eq('id', signalId)
        .maybeSingle();

      if (oneError) throw oneError;

      return response.status(200).json({ success: true, data: one ? [one] : [] });
    }

    // Взимаме сигналите. Селектираме само публичните полета + колоните за вот!
    // 🛠️ Добавено: updated_at, за да може фронтендът да изчисли точно 48-те часа от момента на поправянето!
    const { data, error } = await supabase
      .from('signals')
      .select(PUBLIC_FIELDS)
      .order('created_at', { ascending: false })
      // Таван, за да не расте отговорът безкрайно с годините.
      .limit(MAX_SIGNALS);

    if (error) throw error;

    return response.status(200).json({ success: true, data });
  } catch (err) {
    console.error('Грешка при вземане на сигналите:', err);
    return response.status(500).json({ success: false, error: 'Неуспешно зареждане на регистъра.' });
  }
}
