// File: /api/signals.js
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Resend } from 'resend'; // Импортираме новата библиотека за имейли
import crypto from 'crypto'; // Модул за сигурно генериране на токени
import { resolveRouting, resolveDistrictFromGeo, CATEGORY_KEYS, DISTRICT_LABELS, CATEGORIES, TEST_MODE_RECIPIENT } from './_lib/emailRouting.js';

// Инициализираме AI извън handler-а
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const resend = new Resend(process.env.RESEND_API_KEY); // Инициализация на Resend

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

    // Генериране на уникален токен за автора
    const ownerToken = crypto.randomUUID();

    // =========================================================================
    // БЛОК: ОБРАТНО ГЕОКОДИРАНЕ (САМО ПРИ РЕАЛЕН КЛИК НА КАРТАТА)
    // =========================================================================
    let geoAddress = "";
    let geoDistrict = null; // Район, разпознат по РЕАЛНИ координати (най-достоверен източник)
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
            // Извличаме района от географските данни. Пловдивските райони идват
            // под РАЗЛИЧНИ ключове (borough за повечето, county за „Южен“),
            // затова разчитаме на помощната функция, а не на конкретен ключ.
            geoDistrict = resolveDistrictFromGeo(geoData.address, geoData.display_name);

            const road = geoData.address.road || geoData.address.pedestrian || '';
            const houseNumber = geoData.address.house_number || geoData.address.building || '';
            const quarter = geoData.address.suburb || geoData.address.neighbourhood || '';
            
            if (road) {
              geoAddress = `ул./бул. ${road}${houseNumber ? '№' + houseNumber : ''}`.trim();
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

    // Инициализираме модела със строги системни инструкции
    const model = ai.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      systemInstruction: `Ти си висш административен изкуствен интелект към Гражданския инкубатор на град Пловдив. 
Твоята задача е да поемеш суров сигнал от гражданин и да преминеш през три вътрешни роли, преди да върнеш финалния отговор:
1. РЕЦЕПЦИОНИСТ: Анализираш текста, изчистваш вулгарния език (ако има такъв) и коригираш правописните и пунктуационни грешки, запазвайки оригиналния смисъл.
2. АДМИНИСТРАТОР: Извличаш точния адрес в Пловдив, определяш приоритета (Low, Medium, High) и избираш най-подходящата отговорна институция.
   СТРИКТНИ БИЗНЕС ПРАВИЛА ЗА ИНСТИТУЦИИТЕ (ПАРКИРАНЕ):
   * Ако сигналът описва неправилно паркиран автомобил на пътно платно, тротоар, пред гараж или в Синя/Зелена зона -> ЗАДЪЛЖИТЕЛНО избираш 'ОП Паркиране и репатриране'.
   * Ако сигналът описва автомобил, паркиран вътре в пределите на градски парк, градина, алея, детска площадка или зелена площ -> ЗАДЪЛЖИТЕЛНО избираш 'Пловдивски общински инспекторат (ПОИ)'.
3. ПРАВЕН СЪТРУДНИК: Оформяш официално структурирано писмо съгласно изискванията на Административнопроцесуарния кодекс (АПК) на Република България.

Връщай ЕДИНСТВЕНО валиден JSON оформен обект. Без markdown обвивки (без трите кавички \`\`\`json).`,
    });

    const prompt = `Изпълни следните стъпки за обработка на сигнала последователно:

СТЪПКА 1 (Корекция): Коригирай правописа, граматиката и стилистиката на следния текст на български език: "${rawDescription}". Превърни го в културно, ясно и добре структурирано описание.

СТЪПКА 2 (Администрация): Анализираш коригирания текст и извлечи:
- Точен адрес/локация в град Пловдив.
  * ВНИМАНИЕ: С най-висок приоритет анализирай текста на гражданина ("${rawDescription}"). Ако вътре има споменат конкретен адрес или улица, използвай НЕГО като краен адрес!
  * Ако в текста има посочен номер на сграда/улица (например "ул. Иван Стефанов Гешев 30"), включи го в адреса. 
  * Ако е спомената САМО улица без номер (например "улица Рая"), върни САМО името на улицата (например "ул. Рая")! КАТЕГОРИЧНО СЕ ЗАБРАНЯВА да добавяш измислени номера (като "№ 0") или пояснения от рода на "(без номер)" и "неуточнен"!
  * Ако в текста няма никакъв конкретен адрес или улица, тогава използвай адреса от GPS локатора: "${geoAddress || 'Няма подаден GPS адрес'}".
  * Сглоби адреса красиво, ясно и прецизно.
- Ниво на спешност (priority) – избери точно едно от: 'Low', 'Medium', 'High'.
- Отговорна институция (assigned_institution) – избери най-подходящата от следните: 'ОП Чистота', 'ОП Градини и паркове', 'ОП Организация и контрол на транспорта', 'ОП Паркиране и репатриране', 'Пловдивски общински инспекторат (ПОИ)', 'Район Централен', 'Район Южен', 'Район Северен', 'Район Западен', 'Район Източен', 'Район Тракия', 'Община Пловдив'.
- Категория на проблема (category) – избери ТОЧНО един от следните ключове (връщай самия ключ на латиница, не описанието):
${CATEGORY_KEYS.map(key => `  * '${key}' – ${CATEGORIES[key].label}`).join('\n')}
- Район на инцидента (district) – избери точно едно от: ${DISTRICT_LABELS.map(d => `'${d}'`).join(', ')}.
  * Определи района по адреса/квартала в Пловдив. Ако районът НЕ може да бъде установен със сигурност, върни празен низ "" – КАТЕГОРИЧНО не гадай.
- Вид на уличната мрежа (street_class) – върни 'boulevard', ако проблемът е на ГЛАВЕН БУЛЕВАРД (компетентна е Община Пловдив), или 'local', ако е на местна улица, тротоар или в квартал (компетентно е районното кметство). При съмнение върни 'local'.

СТЪПКА 3 (Правно оформяне): Създай официално писмо-сигнал по чл. 107-111 от АПК. Писмото трябва да съдържа:
- "ДО: [Името на избраната институция]"
- "ОТ: [Три имена на гражданина: ${citizenName}], Имейл: ${citizenEmail}, Тел: ${citizenPhone || 'Не е посочен'}"
- Текст, който официално, сериозно и аргументирано излага проблема, като задължително вписваш извлечения в Стъпка 2 точен адрес вътре в официалното писмо, за да знае общината къде точно да изпрати екип, и призоваваш за проверка на място и последващи действия.
- Официален завършек задължително на два отделни реда:
  "С уважение,"
  "[Имена на гражданина]"


Върни резултата СТРИКТНО като JSON обект със следните полета (и нищо друго):
{
  "corrected_text": "коригираният текст от стъпка 1",
  "location": "крайният сглобен адрес (улица, номер, квартал)",
  "assigned_institution": "избраната институция от стъпка 2",
  "category": "избраният ключ на категорията от стъпка 2",
  "district": "избраният район от стъпка 2 (или празен низ)",
  "street_class": "'boulevard' или 'local' от стъпка 2",
  "priority": "избраният приоритет от стъпка 2",
  "official_letter": "официалното писмо от стъпка 3"
}`;

    // =========================================================================
    //ИЗВЛИЧАНЕ НА ДАННИ ОТ GEMINI СЪС ЗАЩИТА ОТ ГРЕШКИ 503
    // =========================================================================
    let responseText = "";
    const maxRetries = 3; // Брой опити, които системата ще направи

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const aiResponse = await model.generateContent(prompt);
        // Взимаме текста и веднага изчистваме излишните интервали по краищата
        responseText = aiResponse.response.text().trim(); 
        
        // Ако заявката премине успешно, прекъсваме цикъла (retry) и продължаваме напред
        break; 
      } catch (aiError) {
        console.error(`Отказ на Gemini при опит ${attempt} от общо ${maxRetries}:`, aiError);
        
        // Ако това е бил последният опит и все още дава грешка — я хвърляме нагоре към catch блока
        if (attempt === maxRetries) {
          throw aiError; 
        }
        
        // Преди следващия опит правим малка пауза от 800 милисекунди (за да изчакаме сървъра)
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }

    // Твоята съществуваща логика за изчистване на JSON от Markdown тагове (изпълнява се след успешния цикъл)
    if (responseText.startsWith("```")) {
      responseText = responseText.replace(/^```json|```$/g, "").trim();
    }
    // =========================================================================

    const structuredData = JSON.parse(responseText);
// =========================================================================
// БЛОК: НАМИРАНЕ НА КООРДИНАТИ ЧРЕЗ ЧИСТИЯ АДРЕС, ИЗВЛЕЧЕН ОТ ИИ (ПОДСИГУРЕН)
// =========================================================================
if (!finalLat || !finalLng) {
  let aiExtractAddress = structuredData.location || structuredData.Location || geoAddress;
  
  if (aiExtractAddress && aiExtractAddress !== "Неуточнена локация в град Пловдив") {
    try {
      // ПОДОБРЕНО И ДВОЙНО ПОДСИГУРЕНО ПРЕЧИСТВАНЕ ЗА OPENSTREETMAP:
      let cleanSearchAddress = aiExtractAddress
        .replace(/\(.*\)/g, "")                       // Премахва съдържанието в скоби -> (напр. кв. Смирненски)
        .replace(/без номер|неуточнен/gi, "")        // Премахва думи за липса на номер
        .replace(/(ул\.|бул\.|улица|булевард|№)/gi, "") // Премахва префиксите
        .replace(/["'„“«»]/g, "")                     // Премахва абсолютно всички видове кавички
        .replace(/\s+/g, " ")                         // Премахва двойни/множествени интервали
        .trim();

      console.log(`[БЕКЕНД ДИАГНОСТИКА] Опит 1 (Улица): Търсене в LocationIQ за street="${cleanSearchAddress}", city="Пловдив"`);

      // ОПИТ 1: Структурирано търсене за конкретна улица (Защита за малки улици като ул. Младост)
      let forwardResponse = await fetch(
        `https://eu1.locationiq.com/v1/search?key=${process.env.LOCATIONIQ_TOKEN}&street=${encodeURIComponent(cleanSearchAddress)}&city=${encodeURIComponent('Пловдив')}&country=${encodeURIComponent('България')}&format=json&accept-language=bg&addressdetails=1&limit=1`
      );

      let forwardData = [];
      if (forwardResponse.ok) {
        forwardData = await forwardResponse.json();
      }

      // ОПИТ 2 (FALLBACK): Търсене като общ обект/парк/река, ако първият опит за улица не върне резултат
      if (!forwardData || forwardData.length === 0) {
        console.log(`[БЕКЕНД ДИАГНОСТИКА] Опит 2 (Общ обект/Парк): Търсене в LocationIQ за: "${cleanSearchAddress}, Пловдив"`);
        
        forwardResponse = await fetch(
          `https://eu1.locationiq.com/v1/search?key=${process.env.LOCATIONIQ_TOKEN}&q=${encodeURIComponent(cleanSearchAddress + ", Пловдив")}&format=json&accept-language=bg&addressdetails=1&limit=1`
        );

        if (forwardResponse.ok) {
          forwardData = await forwardResponse.json();
        } else {
          console.error(`[LocationIQ ГРЕШКА] Сървърът върна статус: ${forwardResponse.status}`);
        }
      }

      // Обработка на намерените координати от успешен опит
      if (forwardData && forwardData.length > 0) {
        finalLat = parseFloat(forwardData[0].lat);
        finalLng = parseFloat(forwardData[0].lon);

        // Дори когато гражданинът НЕ е маркирал картата, търсенето по адрес
        // връща административната йерархия - използваме я за района.
        if (!geoDistrict) {
          geoDistrict = resolveDistrictFromGeo(forwardData[0].address, forwardData[0].display_name);
        }

        console.log(`[УСПЕХ] Намерени координати за центъра на улицата [${cleanSearchAddress}]: ${finalLat}, ${finalLng}`);
      } else {
        console.log(`[OSM ВНИМАНИЕ] Няма намерени съвпадения за: "${cleanSearchAddress}"`);
      }

    } catch (forwardError) {
      console.error("Грешка при последващо текстово геокодиране:", forwardError);
    }
  }
}
    // =========================================================================
    // ИНТЕЛИГЕНТНО НАСОЧВАНЕ: To = компетентен орган, Cc = изпълнител (ОП)
    // =========================================================================
    // Изчислява се ПРЕДИ записа в базата, за да може решението да бъде
    // съхранено заедно със сигнала (нужно е и на фронтенда, и за одит).
    //
    // ТЕСТОВ РЕЖИМ Е ВКЛЮЧЕН ПО ПОДРАЗБИРАНЕ - цялата поща отива на един
    // тестов адрес и НЕ достига реалните общински кутии.
    //   ROUTING_LIVE=true            -> включва истинското насочване
    //   ROUTING_OVERRIDE_EMAIL=...   -> пренасочва теста към друг адрес
    const isLiveRouting = process.env.ROUTING_LIVE === 'true';
    const testRecipient = isLiveRouting
      ? undefined
      : (process.env.ROUTING_OVERRIDE_EMAIL || TEST_MODE_RECIPIENT);

    const routing = resolveRouting({
      category: structuredData.category,
      district: structuredData.district,
      geoDistrict, // има предимство пред предположението на ИИ
      location: structuredData.location || geoAddress,
      streetClass: structuredData.street_class,
      assignedInstitution: structuredData.assigned_institution,
      centralMunicipalityEmail: process.env.CENTRAL_MUNICIPALITY_EMAIL,
      fallbackEmail: process.env.MUNICIPALITY_FALLBACK_EMAIL || TEST_MODE_RECIPIENT,
      overrideEmail: testRecipient,
    });

    // =========================================================================
    // ДИРЕКТЕН И СИГУРЕН ЗАПИС В SUPABASE ЧРЕЗ HTTP REST API
    // =========================================================================
    try {
      const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
      const supabaseKey = process.env.SUPABASE_ANON_KEY;
      
      const payload = { 
        citizen_name: citizenName,
        citizen_phone: citizenPhone || null,
        citizen_email: citizenEmail,
        raw_description: rawDescription, 
        image_url: imageUrl || null,
        corrected_text: structuredData.corrected_text,
        location: structuredData.location || geoAddress,
        assigned_institution: structuredData.assigned_institution,
        // Проверяваме дали ИИ е върнал валиден приоритет, ако не - слагаме по подразбиране 'Medium'
        priority: ['Low', 'Medium', 'High'].includes(structuredData.priority) ? structuredData.priority : 'Medium',
        official_letter: structuredData.official_letter,
        status: 'Подаден',
        
        // НОВИТЕ КОЛОНИ ЗА ГЕО-ЛОКАЦИЯ (АВТОМАТИЧНИ ИЛИ ОТ КАРТАТА):
        latitude: finalLat || null,
        longitude: finalLng || null,
        owner_token: ownerToken, // Записваме токена в Supabase payload-а

        // РЕЗУЛТАТ ОТ МАРШРУТИЗАЦИЯТА
        // Входни данни (за статистика и филтриране):
        category: routing.resolution.categoryKey || null,
        district: routing.resolution.districtLabel || null,
        street_class: routing.resolution.streetType || null,
        // Взетото решение (показва се на фронтенда и служи за одит):
        responsible_authority: routing.resolution.authorityLabel || null,
        assigned_enterprise: routing.resolution.enterpriseLabel || null
      };

      console.log("Опит за директна HTTP заявка към:", `${supabaseUrl}/rest/v1/signals`);

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
        console.error("Supabase API върна грешка:", supabaseResponse.status, errorText);
        throw new Error(`Supabase HTTP Error ${supabaseResponse.status}: ${errorText}`);
      }

      const insertedData = await supabaseResponse.json();
      const insertedSignal = insertedData[0];

      // =========================================================================
      // БЛОК: АВТОМАТИЧНО ИЗПРАЩАНЕ НА ИМЕЙЛИ ЧРЕЗ RESEND С СУПЕР ЗАЩИТА
      // =========================================================================
      try {
        const signalId = insertedSignal ? insertedSignal.id : "Няма ID";
        // Изграждане на Magic Link за управление през официалния домейн
        const magicLink = `https://signaliplovdiv.org/?manage=${signalId}&token=${ownerToken}`;

        // ПОДГОТОВКА НА ПРИКАЧЕНИЯ ФАЙЛ ЗА RESEND
        let emailAttachments = [];
        if (imageUrl) {
          if (imageUrl.startsWith('data:')) {
            const parts = imageUrl.split(';base64,');
            if (parts.length === 2) {
              const contentType = parts[0].split(':')[1];
              const base64Content = parts[1].replace(/[\r\n\s]/g, '');
              const extension = contentType.split('/')[1] || 'jpg';

              emailAttachments.push({
                filename: `photo_evidence_${signalId}.${extension}`,
                content: base64Content
              });
            }
          } else {
            // Ако imageUrl е директен уеб адрес (например от Supabase Storage)
            emailAttachments.push({
              filename: `photo_evidence_${signalId}.jpg`,
              path: imageUrl
            });
          }
        }
 
        // 1. ИМЕЙЛ ДО ГРАЖДАНИНА (ПОТВЪРЖДЕНИЕ)
        await resend.emails.send({
          from: 'Сигнали Пловдив <no-reply@signaliplovdiv.org>', // Смени с официален мейл след покупка на домейн
          to: [citizenEmail],
          subject: `Сигнал №${signalId} е успешно регистриран - Сигнали Пловдив`,
          attachments: emailAttachments, // Прикачваме снимката като реален файл
          html: `
            <div style="font-family: sans-serif; max-width: 600px; color: #334155; line-height: 1.6;">
              <h2 style="color: #1e1b4b; margin-bottom: 5px;">Здравейте, ${citizenName}!</h2>
              <p style="margin-top: 0;">Благодарим Ви за активната гражданска позиция.</p>
              <p>Вашият сигнал беше успешно заведен под <strong>№${signalId}</strong> в градската система и беше изпратен към съответната институция по служебен път.</p>
              <div style="text-align: center; margin: 25px 0;">
                <a href="${magicLink}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; font-weight: bold; font-size: 14px; border-radius: 6px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
                  Управление и Затваряне на Сигнала
                </a>
                <p style="font-size: 11px; color: #94a3b8; margin-top: 8px;">Използвайте този линк, ако проблемът бъде отстранен, за да го затворите веднага без чакане от всяко устройство.</p>
              </div>

              <div style="background-color: #f8fafc; padding: 15px; border-left: 4px solid #4f46e5; margin: 20px 0; border-radius: 4px;">
                <h4 style="margin-top: 0; color: #4f46e5; margin-bottom: 5px;">Вашето описание:</h4>
                <p style="font-style: italic; margin-bottom: 0; color: #475569;">"${rawDescription}"</p>
              </div>
              ${imageUrl ? `
                <div style="margin-top: 15px; margin-bottom: 15px; padding: 10px; background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px;">
                  <p style="margin: 0; font-size: 13px; color: #1e293b;"><strong>Към имейла е прикачено изпратеното от Вас фотодоказателство.</strong></p>
                </div>
              ` : ''}

              <p>Платформата преформатира сигнала Ви в правно-юридически документ съобразно изискванията на <strong>чл. 107-111 от Административнопроцесуарния кодекс (АПК)</strong>.</p>
              
              <h4 style="color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; margin-top: 25px;">Генериран документ към Общината:</h4>
              <pre style="background-color: #f1f5f9; padding: 12px; border-radius: 6px; font-size: 11px; font-family: monospace; white-space: pre-wrap; color: #1e293b;">${structuredData.official_letter}</pre>
              
              <p style="font-size: 11px; color: #94a3b8; margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 15px;">
                Това е автоматично системно съобщение от Гражданския инкубатор "Сигнали Пловдив". Моля, не отговаряйте директно на този имейл.
              </p>
            </div>
          `
        });

        // 2. ИМЕЙЛ ДО СЪОТВЕТНАТА ИНСТИТУЦИЯ (СЪС СПАСИТЕЛНИЯ REPlY_TO)
        // Маршрутизацията вече е изчислена преди записа в базата (виж по-горе).
        console.log('[МАРШРУТИЗАЦИЯ]', JSON.stringify({
          signalId,
          mode: isLiveRouting ? 'LIVE' : 'TEST',
          actualTo: routing.to,
          actualCc: routing.cc,
          ...routing.resolution,
        }));

        // Предпазна мрежа: ако по някаква причина няма нито един валиден получател,
        // сигналът не се изпраща в нищото - прекъсваме с ясна грешка в лога.
        if (routing.to.length === 0) {
          throw new Error('Няма валиден получател за сигнала (провери MUNICIPALITY_FALLBACK_EMAIL).');
        }

        // Автоматично извличане/подготовка на данните за професионалното заглавие по АПК
        const categoryInfo = routing.resolution.categoryLabel
          || (structuredData.corrected_text ? structuredData.corrected_text.substring(0, 30) + '...' : 'Градска неизправност');
        const locationInfo = structuredData.location || geoAddress;

        // КОРЕКЦИЯ: Изчистване на нови редове в заглавието за предотвратяване на SMTP грешки
        const cleanCategory = String(categoryInfo).replace(/[\r\n]/g, ' ');
        const cleanLocation = String(locationInfo).replace(/[\r\n]/g, ' ');

        await resend.emails.send({
          from: `${citizenName} (през Сигнали Пловдив) <no-reply@signaliplovdiv.org>`,
          to: routing.to,                                   // масив от адреси (Resend формат)
          ...(routing.cc.length > 0 ? { cc: routing.cc } : {}), // Cc се подава само ако има район

          // КЛЮЧОВИЯТ МОМЕНТ: Ако общината натисне "Отговор/Reply", писмото отива при гражданина!
          reply_to: citizenEmail,
          attachments: emailAttachments, // Прикачваме снимката като реален файл

          // ЗАГЛАВИЕ ПО ФОРМУЛАТА НА АПК ЗА ДЪРЖАВНАТА АДМИНИСТРАЦИЯ
          subject: `[СИГНАЛ по чл. 107 от АПК] Относно: ${cleanCategory} – ${cleanLocation} (Подател: ${citizenName})`,
          html: `
            <div style="font-family: sans-serif; max-width: 650px; color: #1e293b; line-height: 1.6;">
              <p><strong>УВАЖАЕМИ ДАМИ И ГОСПОДА,</strong></p>
              <p>По реда на <strong>Глава Осма (чл. 107-111) от Административнопроцесуарния кодекс (АПК)</strong>, Ви изпращаме електронен граждански сигнал, технически пренесен по искане и от името на подателя, свързан с градска неизправност в град Пловдив.</p>
              
              <div style="background-color: #f8fafc; padding: 15px; border: 1px solid #e2e8f0; border-radius: 8px; margin: 20px 0;">
                <strong style="color: #0f172a;">Официални данни за контакт с подателя:</strong><br>
                <strong>• Три имена:</strong> ${citizenName}<br>
                <strong>• Имейл адрес:</strong> <a href="mailto:${citizenEmail}">${citizenEmail}</a><br>
                <strong>• Телефон за връзка:</strong> ${citizenPhone || 'Не е предоставен'}<br>
                <strong>• Локация по ИИ:</strong> ${structuredData.location}<br>
                <strong>• Категория:</strong> ${routing.resolution.categoryLabel || 'Неопределена'}<br>
                <strong>• Район:</strong> ${routing.resolution.districtLabel || 'Неопределен'}<br>
                <strong>• Вид на улицата:</strong> ${routing.resolution.streetType === 'boulevard' ? 'Главен булевард' : 'Местна улица'}<br>
                <strong>• Компетентен орган (адресат):</strong> ${routing.resolution.authorityLabel || 'Община Пловдив'}<br>
                <strong>• Уведомено предприятие (копие):</strong> ${routing.resolution.enterpriseLabel || 'Няма – дейността се извършва от администрацията'}
              </div>

              ${routing.resolution.overrideActive ? `
                <div style="background-color:#fffbeb;border:1px solid #fde68a;padding:12px;border-radius:8px;margin:16px 0;font-size:12px;color:#78350f;">
                  <strong>⚠ ТЕСТОВ РЕЖИМ — това писмо НЕ е изпратено до Общината.</strong><br><br>
                  При реална експлоатация писмото щеше да бъде изпратено до:<br>
                  <strong>To (компетентен орган):</strong> ${routing.resolution.intendedTo || '—'}
                  ${routing.resolution.authorityLabel ? ` (${routing.resolution.authorityLabel})` : ''}<br>
                  <strong>Cc (изпълнител):</strong> ${routing.resolution.intendedCc || '— няма'}
                  ${routing.resolution.enterpriseLabel ? ` (${routing.resolution.enterpriseLabel})` : ''}<br>
                  <strong>Вид улица:</strong> ${routing.resolution.streetType === 'boulevard' ? 'главен булевард' : 'местна улица'}<br><br>
                  За включване на реалното насочване: <code>ROUTING_LIVE=true</code>
                </div>
              ` : ''}

              <h3 style="color: #0f172a; margin-top: 20px; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px;">ПРАВЕН ТЕКСТ НА ЖАЛБАТА:</h3>
              <pre style="background: #f1f5f9; padding: 15px; border-radius: 6px; font-family: monospace; white-space: pre-wrap; font-size: 12px; color: #0f172a; border: 1px solid #e2e8f0;">${structuredData.official_letter}</pre>
              
              ${imageUrl ? `
                <div style="margin-top: 15px; margin-bottom: 15px; padding: 12px; background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;">
                  <p style="margin: 0; font-weight: bold; color: #166534;"> Към писмото е прикачено фотодоказателство от мястото на събитието.</p>
                </div>
              ` : '<p style="color: #64748b; font-style: italic;">Не е прикачена снимка.</p>'}
             
              <p style="background-color: #fffbeb; border: 1px solid #fde68a; padding: 10px; border-radius: 6px; font-size: 11px; color: #78350f; margin-top: 25px;">
                <strong>Техническа бележка за деловодителя:</strong> Настоящото писмо е изпратено от автоматизирания портал за граждански контрол. Моля, използвайте бутона <strong>"Отговори" (Reply)</strong> на Вашата пощенска кутия, за да влезете в директен контакт с подателя на неговия личен имейл.
              </p>
            </div>
          `
        });

        console.log(`Имейлите за Сигнал №${signalId} бяха изпратени успешно през Resend.`);
      } catch (emailError) {
        console.error("Критичен срив в подсистемата за имейли на Resend:", emailError);
      }
      // =========================================================================

      // Предаваме owner_token обратно в JSON обекта, за да може първото устройство да го запази веднага
      return response.status(200).json({ 
        success: true, 
        data: {
          ...insertedSignal,
          owner_token: ownerToken
        } 
      });

    } catch (supabaseRestError) {
      console.error('ПОДРОБНА ДИАГНОСТИКА НА МРЕЖАТА:', {
        message: supabaseRestError.message,
        stack: supabaseRestError.stack,
        cause: supabaseRestError.cause
      });
      throw new Error(`Проблем с базата данни: ${supabaseRestError.message}`);
    }

  } catch (err) {
    console.error('Критична грешка в ИИ Модула:', err);
    return response.status(500).json({ success: false, error: err.message || 'Вътрешна системна грешка.' });
  }
}
