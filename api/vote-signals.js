// File: /api/vote-signals.js
import { createClient } from '@supabase/supabase-js';

// 🔑 ИЗПОЛЗВАМЕ SERVICE_ROLE_KEY, за да може бекендът безопасно да прескача RLS защитите при ъпдейт на статус!
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Сигурна помощна функция за правилно четене на POST тялото във Vercel
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
  // Добавяме CORS хедъри за безпроблемна работа с фронтенда
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. Позволяваме САМО POST заявки (еквивалентно на app.post)
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Методът не е разрешен.' });
  }

  try {
    // Прочитаме сигурно тялото на заявката
    const body = await getRequestBody(req);
    const { id, voteType } = body;

    // 2. Валидация на входните данни
    if (!id || !voteType) {
      return res.status(400).json({ success: false, error: 'Липсва ID на сигнала или тип глас.' });
    }

    // Този маршрут обслужва САМО гражданското гласуване.
    // Затварянето от автора на сигнала се извършва през /api/close-signal.
    if (voteType !== 'still_there' && voteType !== 'fixed') {
      return res.status(400).json({ success: false, error: 'Невалиден тип гласуване.' });
    }

    // =========================================================================
    // ИЗВЛИЧАНЕ НА IP АДРЕСА НА ГЛАСОПОДАВАТЕЛЯ
    // =========================================================================
    // ВАЖНО: x-forwarded-for често е ВЕРИГА ("клиент, proxy1, proxy2").
    // Само първият адрес е реалният клиент. Ако се запише целият низ, един и
    // същ човек, минал през различен прокси път, получава различен user_ip и
    // защитата срещу повторно гласуване тихо престава да работи.
    const forwardedFor = req.headers['x-forwarded-for'];
    const userIp =
      (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) ||
      req.headers['x-real-ip'] ||
      (req.socket && req.socket.remoteAddress) ||
      null;

    if (!userIp) {
      return res.status(400).json({ success: false, error: 'Гласът не може да бъде идентифициран.' });
    }

    // =========================================================================
    // ГЛАСУВАНЕ ЧРЕЗ ЕДНА ТРАНЗАКЦИЯ (Postgres функция cast_vote)
    // =========================================================================
    // Функцията прави всичко наведнъж и атомарно:
    //   * заключва реда на сигнала (без състезание при едновременни гласове)
    //   * презаписва съществуващия глас вместо да добавя нов ред
    //   * ИЗЧИСЛЯВА броячите от таблицата, вместо да ги увеличава
    // Затова един човек не може да събере 3 гласа, колкото и пъти да смени вота си.
    const { data: result, error: rpcError } = await supabase.rpc('cast_vote', {
      p_signal_id: id,
      p_user_ip: userIp,
      p_vote_type: voteType,
    });

    if (rpcError) {
      throw rpcError;
    }

    if (!result || result.ok !== true) {
      const reason = result ? result.error : 'unknown';
      const messages = {
        not_found: 'Сигналът не е намерен.',
        already_resolved: 'Този сигнал вече е маркиран като решен.',
        invalid_vote_type: 'Невалиден тип гласуване.',
        missing_voter: 'Гласът не може да бъде идентифициран.',
      };
      const status = reason === 'not_found' ? 404 : 400;
      return res.status(status).json({
        success: false,
        error: messages[reason] || 'Гласът не можа да бъде отчетен.',
      });
    }

    // Съобщение според това какво реално се случи
    let message;
    if (result.votes_fixed >= 3) {
      message = 'Благодарим Ви! Сигналът беше затворен успешно от гражданите.';
    } else if (result.changed) {
      message = 'Гласът Ви беше променен успешно!';
    } else {
      message = 'Гласът Ви бе успешно отчетен!';
    }

    return res.status(200).json({
      success: true,
      message,
      current_status: result.status,
      vote_type: result.vote_type,          // текущият глас на този потребител
      changed: result.changed,              // true = смяна на предишен глас
      votes_fixed: result.votes_fixed,
      votes_still_there: result.votes_still_there,
    });

  } catch (err) {
    console.error('Грешка при краудсорсинг гласуване:', err);
    return res.status(500).json({ success: false, error: 'Вътрешна сървърна грешка при обработка на вота.', details: err.message });
  }
}
