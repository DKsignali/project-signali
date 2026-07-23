// File: /api/signals.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Resend } from 'resend'; 
import crypto from 'crypto'; 

// Инициализираме AI и Resend извън handler-а
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const resend = new Resend(process.env.RESEND_API_KEY); 

// Инициализация на Supabase клиент за вътрешни бекенд заявки (използва SERVICE ROLE за максимален достъп)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// 📌 ПОМОЩНА ФУНКЦИЯ: Динамично извличане на TO и CC имейли от Supabase справочника
async function getEmailRecipients(assignedInstitutionName, districtName) {
  try {
    // 1. Взимаме TO имейла за избраната институция
    const { data: instData } = await supabase
      .from('institutions')
      .select('primary_email')
      .eq('key_name', assignedInstitutionName)
      .maybeSingle();

    // 2. Взимаме CC имейла(ите) за съответното районно кметство
    const { data: distData } = await supabase
      .from('districts')
      .select('cc_email')
      .eq('district_name', districtName)
      .maybeSingle();

    // Обработваме CC имейлите (поддържа единичен низ или масив text[])
    let ccRecipients = ['info@plovdiv.bg']; // Fallback по подразбиране
    if (distData && distData.cc_email) {
      if (Array.isArray(distData.cc_email)) {
        ccRecipients = distData.cc_email;
      } else if (typeof distData.cc_email === 'string') {
        ccRecipients = [distData.cc_email];
      }
    }

    return {
      to: instData?.primary_email || 'info@plovdiv.bg',
      cc: ccRecipients
    };
  } catch (err) {
    console.error("Грешка при извличане на имейл адреси от справочника:", err);
    return {
      to: 'info@plovdiv.bg',
      cc: ['info@plovdiv.bg']
    };
  }
}

async function getRequestBody(req) {
  if (req.body) return req.body;
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  const data = Buffer.concat(buffers).toString();
  return JSON.parse(data);
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Методът не е разрешен.' });
  }

  try {
    const body = await getRequestBody(request);
    const { citizenName, citizenPhone, citizenEmail, rawDescription, imageUrl, latitude, longitude } = body;

    if (!citizenName || !citizenEmail || !rawDescription) {
      return response.status(400).json({ error: 'Име, имейл и описание са задължителни по АПК.' });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      throw new Error("Липсват конфигурационни ключове за Supabase във Vercel.");
    }

    const ownerToken = crypto.randomUUID();

    // =========================================================================
    // БЛОК: ОБРАТНО ГЕОКОДИРАНЕ (LOCATIONIQ)
    // =========================================================================
    let geoAddress = "";
    let finalLat = latitude;
    let finalLng = longitude;

    if (finalLat && finalLng) {
      try {
        const geoResponse = await fetch(
          `https://eu1.locationiq.com/v1/reverse?key=${process.env.LOCATIONIQ_TOKEN}&lat=${finalLat}&lon=${finalLng}&format=json&accept-language=bg&addressdetails=1&zoom=18`
        );
        
        if (geoResponse.ok) {
          const geoData = await geoResponse.json();
          if (geoData && geoData.address) {
            const road = geoData.address.road || geoData.address.pedestrian || '';
            const houseNumber = geoData.address.house_number || geoData.address.building || '';
            const quarter = geoData.address.suburb || geoData.address.neighbourhood || '';
            
            if (road) {
              geoAddress = `ул./бул. ${road}${houseNumber ? ' №' + houseNumber : ''}`.trim();
              if (quarter) geoAddress += ` (кв. ${quarter})`;
            } else if (geoData.display_name) {
              geoAddress = geoData.display_name;
            }
          }
        }
      } catch (geoError) {
        console.error("Грешка при reverse geocoding:", geoError);
      }
    }

    // =========================================================================
    // БЛОК: GEMINI AI ИНИЦИАЛИЗАЦИЯ И ОБРАБОТКА
    // =========================================================================
    const model = ai.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      systemInstruction: `Ти си висш административен изкуствен интелект към Гражданския инкубатор на град Пловдив. 
Твоята задача е да поемеш суров сигнал от гражданин и да преминеш през три вътрешни роли, преди да върнеш финалния отговор:
1. РЕЦЕПЦИОНИСТ: Анализираш текста, изчистваш вулгарния език (ако има такъв) и коригираш правописните и пунктуационни грешки, запазвайки оригиналния смисъл.
2. АДМИНИСТРАТОР: Извличаш точния адрес в Пловдив, определяш приоритета (Low, Medium, High), определяш административния район в Пловдив и избираш най-подходящата отговорна институция.
   ⚠️ СТРИКТНИ БИЗНЕС ПРАВИЛА ЗА ИНСТИТУЦИИТЕ (ПАРКИРАНЕ):
   * Ако сигналът описва неправилно паркиран автомобил на пътно платно, тротоар, пред гараж или в Синя/Зелена зона -> ЗАДЪЛЖИТЕЛНО избираш 'ОП Паркиране и репатриране'.
   * Ако сигналът описва автомобил, паркиран вътре в пределите на градски парк, градина, алея, детска площадка или зелена площ -> ЗАДЪЛЖИТЕЛНО избираш 'Пловдивски общински инспекторат (ПОИ)'.
3. ПРАВЕН СЪТРУДНИК: Оформяш официално структурирано писмо съгласно изискванията на Административнопроцесуарния кодекс (АПК) на Република България.

Връщай ЕДИНСТВЕНО валиден JSON оформен обект. Без markdown обвивки (без трите кавички \`\`\`json).`,
    });

    const prompt = `Изпълни следните стъпки за обработка на сигнала последователно:

СТЪПКА 1 (Корекция): Коригирай правописа, граматиката и стилистиката на следния текст на български език: "${rawDescription}". Превърни го в културно, ясно и добре структурирано описание.

СТЪПКА 2 (Администрация): Анализираш коригирания текст и извлечи:
- Точен адрес/локация в град Пловдив.
  * ВНИМАНИЕ: С най-висок приоритет анализирай текста на гражданина ("${rawDescription}"). Ако вътре има споменат конкретен адрес, улица и номер (например "ул. Иван Стефанов Гешев 30"), използвай НЕГО като краен адрес!
  * Ако в текста няма конкретен адрес, тогава използвай адреса от GPS локатора: "${geoAddress || 'Няма подаден GPS адрес'}".
  * Сглоби адреса красиво, ясно, задължително включвайки номера на улицата или сградата.
- Административен район – избери ТOЧНО едно от: 'Район Централен', 'Район Южен', 'Район Северен', 'Район Западен', 'Район Източен', 'Район Тракия'. (Ако не е сигурно, определи по адреса).
- Ниво на спешност (priority) – избери точно едно от: 'Low', 'Medium', 'High'.
- Отговорна институция (assigned_institution) – избери най-подходящата от следните: 'ОП Чистота', 'ОП Градини и паркове', 'ОП Организация и контрол на транспорта', 'ОП Паркиране и репатриране', 'Пловдивски общински инспекторат (ПОИ)', 'Район Централен', 'Район Южен', 'Район Северен', 'Район Западен', 'Район Източен', 'Район Тракия', 'Община Пловдив'.

СТЪПКА 3 (Правно оформяне): Създай официално писмо-сигнал по чл. 107-111 от АПК. Писмото трябва да съдържа:
- "ДО: [Името на избраната институция]"
- "ОТ: [Три имена на гражданина: ${citizenName}], Имейл: ${citizenEmail}, Тел: ${citizenPhone || 'Не е посочен'}"
- Текст, който официално, сериозно и аргументирано излага проблема, като задължително вписваш извлечения в Стъпка 2 точен адрес вътре в официалното писмо.
- Официален завършек задължително на два отделни реда:
  "С уважение,"
  "[Имена на гражданина]"

Върни резултата СТРИКТНО като JSON обект със следните полета (и нищо друго):
{
  "corrected_text": "коригираният текст от стъпка 1",
  "location": "крайният сглобен адрес (улица, номер, квартал)",
  "district": "избраният район от стъпка 2",
  "assigned_institution": "избраната институция от стъпка 2",
  "priority": "избраният приоритет от стъпка 2",
  "official_letter": "официалното писмо от стъпка 3"
}`;

    let responseText = "";
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const aiResponse = await model.generateContent(prompt);
        responseText = aiResponse.response.text().trim(); 
        break; 
      } catch (aiError) {
        console.error(`Отказ на Gemini при опит ${attempt} от общо ${maxRetries}:`, aiError);
        if (attempt === maxRetries) throw aiError; 
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }

    if (responseText.startsWith("```")) {
      responseText = responseText.replace(/^```json|```$/g, "").trim();
    }

    const structuredData = JSON.parse(responseText);

    // =========================================================================
    // БЛОК: ТЕКСТОВО ГЕОКОДИРАНЕ (АКО ЛИПСВАТ GPS КООРДИНАТИ)
    // =========================================================================
    if (!finalLat || !finalLng) {
      let aiExtractAddress = structuredData.location || structuredData.Location || geoAddress;
      
      if (aiExtractAddress && aiExtractAddress !== "Неуточнена локация в град Пловдив") {
        try {
          let cleanSearchAddress = aiExtractAddress
            .replace(/(ул\.|бул\.|улица|булевард|„|“|"|'|№)/gi, "")
            .replace(/\s+/g, " ")
            .trim();

          const forwardResponse = await fetch(
            `[https://eu1.locationiq.com/v1/search?key=$](https://eu1.locationiq.com/v1/search?key=$){process.env.LOCATIONIQ_TOKEN}&q=${encodeURIComponent(cleanSearchAddress + ", Пловдив")}&format=json&accept-language=bg&limit=1`
          );
          
          if (forwardResponse.ok) {
            const forwardData = await forwardResponse.json();
            if (forwardData && forwardData.length > 0) {
              finalLat = parseFloat(forwardData[0].lat);
              finalLng = parseFloat(forwardData[0].lon);
            }
          }
        } catch (forwardError) {
          console.error("Грешка при последващо текстово геокодиране:", forwardError);
        }
      }
    }

    // =========================================================================
    // БЛОК: ЗАПИС В SUPABASE (ТАБЛИЦА SIGNALS)
    // =========================================================================
    const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, ""); 
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    
    const payload = { 
      citizen_name: citizenName,
      citizen_phone: citizenPhone || null,
      citizen_email: citizenEmail,
      raw_description: rawDescription, 
      image_url: imageUrl || null,
      corrected_text: structuredData.corrected_text,
      location: structuredData.location || geoAddress,
      assigned_institution: structuredData.assigned_institution,
      priority: ['Low', 'Medium', 'High'].includes(structuredData.priority) ? structuredData.priority : 'Medium',
      official_letter: structuredData.official_letter,
      status: 'Подаден',
      latitude: finalLat || null,
      longitude: finalLng || null,
      owner_token: ownerToken 
    };

    const supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/signals`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(payload)
    });

    if (!supabaseResponse.ok) {
      const errorText = await supabaseResponse.text();
      throw new Error(`Supabase HTTP Error ${supabaseResponse.status}: ${errorText}`);
    }

    const insertedData = await supabaseResponse.json();
    const insertedSignal = insertedData[0];

    // =========================================================================
    // БЛОК: ИЗВЛИЧАНЕ НА ИМЕЙЛИ ОТ СПРАВОЧНИКА И ИЗПРАЩАНЕ ЧРЕЗ RESEND
    // =========================================================================
    try {
      const signalId = insertedSignal ? insertedSignal.id : "Няма ID";
      const magicLink = `[https://project-signali.vercel.app/?manage=$](https://project-signali.vercel.app/?manage=$){signalId}&token=${ownerToken}`;

      // 📌 ИЗВЛИЧАМЕ TO И CC ИМЕЙЛИТЕ ОТ СПРАВОЧНИКА В SUPABASE
      const recipients = await getEmailRecipients(structuredData.assigned_institution, structuredData.district);
      console.log(`[ИМЕЙЛ МАРШРУТИЗИРАНЕ] За сигнал №${signalId}: TO -> ${recipients.to} | CC -> ${recipients.cc.join(', ')}`);

      // Подготовка на прикачения файл (ако има снимка)
      let emailAttachments = [];
      if (imageUrl) {
        if (imageUrl.startsWith('data:')) {
          const parts = imageUrl.split(';base64,');
          if (parts.length === 2) {
            const contentType = parts[0].split(':')[1];
            const base64Content = parts[1];
            const extension = contentType.split('/')[1] || 'jpg';

            emailAttachments.push({
              filename: `photo_evidence_${signalId}.${extension}`,
              content: base64Content
            });
          }
        } else {
          emailAttachments.push({
            filename: `photo_evidence_${signalId}.jpg`,
            path: imageUrl
          });
        }
      }

      // 1. ПОТВЪРЖДЕНИЕ ДО ГРАЖДАНИНА
      await resend.emails.send({
        from: 'Сигнали Пловдив <onboarding@resend.dev>', 
        to: [citizenEmail],
        subject: `🚨 Сигнал №${signalId} е успешно регистриран - Сигнали Пловдив`,
        attachments: emailAttachments,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; color: #334155; line-height: 1.6;">
            <h2 style="color: #1e1b4b; margin-bottom: 5px;">Здравейте, ${citizenName}!</h2>
            <p style="margin-top: 0;">Благодарим Ви за активната гражданска позиция.</p>
            <p>Вашият сигнал беше успешно заведен под <strong>№${signalId}</strong> в градската система и беше изпратен към <strong>${structuredData.assigned_institution}</strong> по служебен път.</p>
            
            <div style="text-align: center; margin: 25px 0;">
              <a href="${magicLink}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; font-weight: bold; font-size: 14px; border-radius: 6px; display: inline-block;">
                ⚡ Управление и Затваряне на Сигнала
              </a>
            </div>

            <div style="background-color: #f8fafc; padding: 15px; border-left: 4px solid #4f46e5; margin: 20px 0; border-radius: 4px;">
              <h4 style="margin-top: 0; color: #4f46e5; margin-bottom: 5px;">Вашето описание:</h4>
              <p style="font-style: italic; margin-bottom: 0; color: #475569;">"${rawDescription}"</p>
            </div>

            <h4 style="color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; margin-top: 25px;">Генериран документ към Общината:</h4>
            <pre style="background-color: #f1f5f9; padding: 12px; border-radius: 6px; font-size: 11px; font-family: monospace; white-space: pre-wrap; color: #1e293b;">${structuredData.official_letter}</pre>
          </div>
        `
      });

      // 2. ОФИЦИАЛЕН ИМЕЙЛ ДО ИНСТИТУЦИЯТА (TO) С КОПИЕ ДО КМЕТСТВОТО (CC)
      // За тестовия период може да промениш targetEmail и да добавиш testCcEmail, а при готова продукция ползваш recipients.to и изтриваш testCcEmail 
      const targetEmail = 'dkbusiness901@gmail.com'; // Твоят личен имейл за тестове
      const testCcEmail = ['DKsignali@proton.me']; // Използваме твоя имейл и за CC, за да не гърми Resend
      const categoryInfo = structuredData.corrected_text ? structuredData.corrected_text.substring(0, 30) + '...' : 'Градска неизправност';
      const locationInfo = structuredData.location || geoAddress;

      await resend.emails.send({
        from: `${citizenName} (през Сигнали Пловдив) <onboarding@resend.dev>`, 
        to: [targetEmail],
        cc: testCcEmail, // 📌 Автоматично добавяме кметството в CC (поддържа и масиви от 2+ имейла!) // 👈 Заместваш recipients.cc с testCcEmail за тестовия период
        reply_to: citizenEmail,
        attachments: emailAttachments,
        subject: `[СИГНАЛ по чл. 107 от АПК] Относно: ${categoryInfo} – ${locationInfo} (Подател: ${citizenName})`,
        html: `
          <div style="font-family: sans-serif; max-width: 650px; color: #1e293b; line-height: 1.6;">
            <p><strong>УВАЖАЕМИ ДАМИ И ГОСПОДА,</strong></p>
            <p>По реда на <strong>Глава Осма (чл. 107-111) от Административнопроцесуарния кодекс (АПК)</strong>, Ви изпращаме електронен граждански сигнал, свързан с градска неизправност в град Пловдив.</p>
            
            <div style="background-color: #f8fafc; padding: 15px; border: 1px solid #e2e8f0; border-radius: 8px; margin: 20px 0;">
              <strong style="color: #0f172a;">Официални данни за контакт с подателя:</strong><br>
              👤 Имена: ${citizenName}<br>
              ✉️ Имейл адрес: <a href="mailto:${citizenEmail}">${citizenEmail}</a><br>
              📞 Телефон за връзка: ${citizenPhone || 'Не е предоставен'}<br>
              📍 Локация : ${structuredData.location} (${structuredData.district || 'Пловдив'})
            </div>

            <h3 style="color: #0f172a; margin-top: 20px; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px;">ПРАВЕН ТЕКСТ НА ЖАЛБАТА:</h3>
            <pre style="background: #f1f5f9; padding: 15px; border-radius: 6px; font-family: monospace; white-space: pre-wrap; font-size: 12px; color: #0f172a; border: 1px solid #e2e8f0;">${structuredData.official_letter}</pre>
            
            ${imageUrl ? `
              <div style="margin-top: 15px; margin-bottom: 15px; padding: 12px; background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;">
                <p style="margin: 0; font-weight: bold; color: #166534;">📎 Към писмото е прикачено фотодоказателство от мястото на събитието.</p>
              </div>
            ` : '<p style="color: #64748b; font-style: italic;">Не е прикачена снимка.</p>'}
           
            <p style="background-color: #fffbeb; border: 1px solid #fde68a; padding: 10px; border-radius: 6px; font-size: 11px; color: #78350f; margin-top: 25px;">
              ℹ️ <strong>Техническа бележка за деловодителя:</strong> Настоящото писмо е изпратено от автоматизирания портал за граждански контрол. Моля, използвайте бутона <strong>"Отговори" (Reply)</strong> на Вашата пощенска кутия, за да влезете в директен контакт с подателя.
            </p>
          </div>
        `
      });

      console.log(`Имейлите за Сигнал №${signalId} бяха изпратени успешно с TO=${recipients.to} и CC=${recipients.cc.join(',')}`);
    } catch (emailError) {
      console.error("Срив в подсистемата за имейли на Resend:", emailError);
    }

    return response.status(200).json({ 
      success: true, 
      data: {
        ...insertedSignal,
        owner_token: ownerToken
      } 
    });

  } catch (err) {
    console.error('Критична грешка в ИИ Модула:', err);
    return response.status(500).json({ success: false, error: err.message || 'Вътрешна системна грешка.' });
  }
}
