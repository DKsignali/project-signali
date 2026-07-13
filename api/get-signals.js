// File: /api/get-signals.js
import { createClient } from '@supabase/supabase-js';

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

    // Взимаме сигналите. Селектираме само публичните полета + колоните за вот!
    // 🛠️ Добавено: updated_at, за да може фронтендът да изчисли точно 48-те часа от момента на поправянето!
    const { data, error } = await supabase
      .from('signals')
      .select('id, created_at, updated_at, corrected_text, location, assigned_institution, priority, status, image_url, latitude, longitude, votes_still_there, votes_fixed')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return response.status(200).json({ success: true, data });
  } catch (err) {
    console.error('Грешка при вземане на сигналите:', err);
    return response.status(500).json({ success: false, error: 'Неуспешно зареждане на регистъра.' });
  }
}
