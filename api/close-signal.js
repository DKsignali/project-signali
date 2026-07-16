// File: /api/close-signal.js
import { createClient } from '@supabase/supabase-js';

// 🔑 ИЗПОЛЗВАМЕ SERVICE_ROLE_KEY, за да може бекендът безопасно да прескача RLS защитите при ъпдейт!
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Сигурна помощна функция за правилно четене на POST тялото във Vercel environments
async function getRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (req.body && typeof req.body === 'string') return JSON.parse(req.body);
  
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  const data = Buffer.concat(buffers).toString();
  return data ? JSON.parse(data) : {};
}

export default async function handler(req, res) {
  // CORS Хедъри за безпроблемна комуникация с фронтенда
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. Позволяваме САМО POST заявки
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Методът не е разрешен.' });
  }

  try {
    const body = await getRequestBody(req);
    const { id, token } = body;

    // 2. Валидация на входните данни
    if (!id || !token) {
      return res.status(400).json({ success: false, error: 'Липсва ID на сигнала или идентификационен токен.' });
    }

    // 3. Вземаме сигнала от Supabase заедно с неговия таен owner_token
    const { data: existingSignal, error: fetchOwnerError } = await supabase
      .from('signals')
      .select('owner_token, votes_still_there')
      .eq('id', id)
      .single();

    if (fetchOwnerError || !existingSignal) {
      return res.status(404).json({ success: false, error: 'Сигналът не е намерен.' });
    }

    // 4. ВАЛИДАЦИЯ: Проверяваме съвпадението на токените
    if (existingSignal.owner_token !== token) {
      return res.status(403).json({ success: false, error: 'Грешен или невалиден токен за управление.' });
    }

    // 5. Обновяваме статуса на 'Решен' (точно както изисква твоят signals_status_check)
    const { error: updateOwnerError } = await supabase
      .from('signals')
      .update({ 
        status: 'Решен',
        votes_fixed: 3, 
        votes_still_there: existingSignal.votes_still_there || 0,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateOwnerError) throw updateOwnerError;

    // 6. Връщаме успешен отговор към фронтенда
    return res.status(200).json({
      success: true,
      message: 'Благодарим Ви! Вие затворихте Вашия сигнал успешно.',
      current_status: 'Решен'
    });

  } catch (err) {
    console.error('Подробна грешка в close-signal:', err);
    return res.status(500).json({ 
      success: false, 
      error: 'Вътрешна сървърна грешка при прекратяване на сигнала.',
      details: err.message 
    });
  }
}
