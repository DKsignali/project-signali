// File: /api/_lib/emailRouting.js
//
// МОДУЛ ЗА ИНТЕЛИГЕНТНО НАСОЧВАНЕ НА СИГНАЛИТЕ
// =============================================================================
// ФОРМУЛА (двете вериги се задействат едновременно):
//
//   To  -> КОМПЕТЕНТНИЯТ АДМИНИСТРАТИВЕН ОРГАН
//          * районно кметство      - при местни улици
//          * Община Пловдив        - при главни булеварди
//          Само административен орган може да образува преписка и да издаде
//          ОФИЦИАЛЕН ВХОДЯЩ НОМЕР по чл. 107-111 от АПК.
//
//   Cc  -> СПЕЦИАЛИЗИРАНОТО ОБЩИНСКО ПРЕДПРИЯТИЕ (ОП „Чистота“, ОП „Градини
//          и паркове“ и т.н.) - изпълнителят, който извършва самата дейност.
//          ОП НЕ е административен орган и не образува преписка.
//
// Модулът е нарочно "чист": без Resend, без Supabase, без достъп до мрежата.
//
// ВАЖНО: Папката се казва "_lib" - Vercel НЕ публикува файлове и папки,
// започващи с долна черта, като отделни serverless функции.
// =============================================================================

// -----------------------------------------------------------------------------
// 1. РАЙОННИ КМЕТСТВА - административен орган за местните улици (To)
// -----------------------------------------------------------------------------
// Адресите съвпадат с таблицата public.districts в Supabase.
export const DISTRICTS = {
  centralen: { label: 'Район Централен', email: 'centralen@plovdiv.bg' },
  yuzhen:    { label: 'Район Южен',      email: 'signal@south-plovdiv.bg' },
  severen:   { label: 'Район Северен',   email: 'info@severen.plovdiv.bg' },
  zapaden:   { label: 'Район Западен',   email: 'zapaden@plovdiv.bg' },
  iztochen:  { label: 'Район Източен',   email: 'info@iztochen-plovdiv.bg' },
  trakia:    { label: 'Район Тракия',    email: 'trakia@plovdiv.bg' },
};

// Централна администрация - компетентният орган за главните булеварди и
// резервен адресат, когато районът не може да бъде определен.
// Съответства на реда „Община Пловдив“ в таблицата public.institutions.
export const CENTRAL_MUNICIPALITY = {
  label: 'Община Пловдив',
  email: 'info@plovdiv.bg',
};

// =============================================================================
// ТЕСТОВ РЕЖИМ (ВКЛЮЧЕН ПО ПОДРАЗБИРАНЕ)
// =============================================================================
// Докато платформата се тества, ЦЯЛАТА поща към институции отива на този
// адрес и НЕ достига реалните общински пощенски кутии. Реално изчислените
// To/Cc се записват в лога и се показват в самото писмо, за да може
// маршрутизацията да бъде проверена без да се безпокои Общината.
//
// ЗА ПУСКАНЕ В РЕАЛНА ЕКСПЛОАТАЦИЯ: задайте променлива на средата
//   ROUTING_LIVE=true
// Това е единственото действие, необходимо за включване на истинското
// насочване - не се налага промяна в кода.
export const TEST_MODE_RECIPIENT = 'dkbusiness901@gmail.com';

const DISTRICT_ALIASES = {
  centralen: ['централен', 'centralen', 'център', 'centar'],
  yuzhen:    ['южен', 'yuzhen', 'juzhen', 'south'],
  severen:   ['северен', 'severen'],
  zapaden:   ['западен', 'zapaden'],
  iztochen:  ['източен', 'iztochen'],
  trakia:    ['тракия', 'trakia', 'trakiya'],
};

// -----------------------------------------------------------------------------
// 2. ОБЩИНСКИ ПРЕДПРИЯТИЯ (ОП) - изпълнители, отиват в Cc
// -----------------------------------------------------------------------------
export const ENTERPRISES = {
  gradini_parkove: { name: 'ОП „Градини и паркове“',                                   email: 'gradini_parkove@plovdiv.bg' },
  jilfond:         { name: 'ОП „Жилфонд“',                                             email: 'opjilfond@plovdiv.bg' },
  okt:             { name: 'ОП „Организация и контрол по транспорта“',                 email: 'op_okt@plovdiv.bg' },
  pazari:          { name: 'ОП „Общински пазари“',                                     email: 'pazari@plovdiv.bg' },
  radostni_obredi: { name: 'ОП „Радостни обреди“',                                     email: 'radostniobredi@plovdiv.bg' },
  traurna:         { name: 'ОП „Траурна дейност“',                                     email: 'op_traurna_deinost@plovdiv.bg' },
  parkirane:       { name: 'ОП „Паркиране и репатриране“',                             email: 'op_parkirane@plovdiv.bg' },
  ohrana:          { name: 'ОП „Общинска охрана“',                                     email: 'op_ohrana@plovdiv.bg' },
  dezstancia:      { name: 'ОП „Дезинфекционна станция“',                              email: 'dezstancia@plovdiv.bg' },
  zvk:             { name: 'ОП „Зооветеринарен комплекс“',                             email: 'op_zvk@plovdiv.bg' },
  chistota:        { name: 'ОП „Чистота“',                                             email: 'chistota@plovdiv.bg' },
  mladezhki:       { name: 'ОП „Младежки център Пловдив“',                             email: 'opk_mladost@plovdiv.bg' },
  sportna_zala:    { name: 'ОП „Многофункционална спортна зала“',                      email: 'kolodruma@plovdiv.bg' },
  socialno:        { name: 'ОП „Социално предприятие за хора с увреждания – Пловдив“', email: 'spxu.plovdiv@plovdiv.bg' },
  zoo:             { name: 'ОП „Зоологическа градина – Пловдив“',                      email: 'zoo@plovdiv.bg' },
};

// -----------------------------------------------------------------------------
// 3. КАТЕГОРИИ -> ИЗПЪЛНИТЕЛНО ПРЕДПРИЯТИЕ (Cc)
// -----------------------------------------------------------------------------
// Категории без "enterprise" се извършват от самата администрация - тогава
// няма Cc и писмото отива само до компетентния орган.
export const CATEGORIES = {
  street_lighting:     { label: 'Улично осветление',               enterprise: 'okt' },
  illegal_parking:     { label: 'Неправилно паркиране',            enterprise: 'parkirane' },
  abandoned_vehicles:  { label: 'Изоставени автомобили',           enterprise: 'parkirane' },
  waste:               { label: 'Отпадъци и чистота',              enterprise: 'chistota' },
  green_areas:         { label: 'Зелени площи и паркове',          enterprise: 'gradini_parkove' },
  stray_animals:       { label: 'Безстопанствени животни',         enterprise: 'zvk' },
  pests_disinfection:  { label: 'Вредители и дезинфекция',         enterprise: 'dezstancia' },
  markets:             { label: 'Общински пазари',                 enterprise: 'pazari' },
  cemeteries:          { label: 'Гробищни паркове',                enterprise: 'traurna' },
  municipal_housing:   { label: 'Общински жилища и сгради',        enterprise: 'jilfond' },
  public_order:        { label: 'Шум и обществен ред',             enterprise: 'ohrana' },
  road_infrastructure: { label: 'Пътна инфраструктура и тротоари', enterprise: null },
  water_sewage:        { label: 'ВиК проблеми',                    enterprise: null },
  other:               { label: 'Друго',                           enterprise: null },
};

// -----------------------------------------------------------------------------
// 4. КЛАСИФИКАЦИЯ НА УЛИЦАТА: МЕСТНА или ГЛАВЕН БУЛЕВАРД
// -----------------------------------------------------------------------------
// Главните булеварди са от компетентността на Община Пловдив (централно),
// местните улици - на съответното районно кметство.
//
// Списъкът е допълваем: имената тук се разпознават и когато адресът е изписан
// БЕЗ представка "бул.".
export const MAJOR_BOULEVARDS = [
  'христо ботев',
  'цар борис iii обединител',
  'найчо цанов',
  'българия',
  'северен',
  'руски',
  'васил априлов',
  'шести септември',
  'марица',
  'санкт петербург',
  'пещерско шосе',
  'кукленско шосе',
  'освобождение',
  'дунав',
  'копривщица',
];

const BOULEVARD_TOKENS = new Set(['бул', 'бул.', 'булевард']);
const STREET_TOKENS = new Set(['ул', 'ул.', 'улица']);

// -----------------------------------------------------------------------------
// 5. ПОМОЩНИ ФУНКЦИИ
// -----------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/i;

export function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

function normalize(value) {
  return String(value == null ? '' : value).toLowerCase().trim();
}

function tokenize(value) {
  return normalize(value).split(/[\s,;()]+/).filter(Boolean);
}

// ВНИМАНИЕ: \b в JavaScript работи само с ASCII (\w) и НЕ може да служи за
// граница на кирилски думи. Затова навсякъде се работи с токени, не с \b.
const IGNORED_WORDS = new Set(['на', 'по']);

function normalizeInstitution(value) {
  return normalize(value)
    .replace(/[„“”"'‘’]/g, '')
    .split(/\s+/)
    .filter(word => word && !IGNORED_WORDS.has(word))
    .join(' ')
    .trim();
}

const INSTITUTION_INDEX = new Map(
  Object.values(ENTERPRISES).map(e => [normalizeInstitution(e.name), e.email])
);

/**
 * Определя дали адресът е на главен булевард (Община Пловдив) или на местна
 * улица (районно кметство).
 *
 * ВАЖНО: проверката за "бул." задължително е ПРЕДИ тази за "ул.", защото
 * низът "бул." съдържа "ул." като подниз.
 *
 * @returns {'boulevard'|'local'}
 */
export function classifyStreet(location, aiHint) {
  const tokens = tokenize(location);

  // 1) Изрична представка в адреса - най-надеждният признак.
  if (tokens.some(t => BOULEVARD_TOKENS.has(t))) return 'boulevard';

  // 2) Известен главен булевард, изписан без представка.
  const text = normalize(location);
  if (MAJOR_BOULEVARDS.some(name => text.includes(name))) return 'boulevard';

  // 3) Изрично "ул." -> местна улица.
  if (tokens.some(t => STREET_TOKENS.has(t))) return 'local';

  // 4) Подсказка от ИИ, ако адресът не носи информация.
  const hint = normalize(aiHint);
  if (hint === 'boulevard' || hint === 'булевард') return 'boulevard';

  // 5) По подразбиране - местна улица. Районното кметство е най-близкият
  //    компетентен орган и може да препрати нагоре при нужда.
  return 'local';
}

export function resolveDistrictKey(input) {
  const text = normalize(input);
  if (!text) return null;
  for (const [key, aliases] of Object.entries(DISTRICT_ALIASES)) {
    if (aliases.some(alias => text.includes(alias))) return key;
  }
  return null;
}

// Ключове, под които Nominatim/LocationIQ може да върне пловдивския район.
// ВАЖНО: районите НЕ са под един и същ ключ - „Централен“, „Западен“,
// „Северен“, „Източен“ и „Тракия“ идват като borough, а „Южен“ като county.
// Затова се проверяват няколко ключа, а накрая се сканират всички стойности.
const GEO_DISTRICT_KEYS = ['borough', 'county', 'city_district', 'district', 'municipality', 'suburb'];

/**
 * Определя района по данните от геокодера - най-надеждният източник, защото
 * се базира на реалните координати, а не на предположение от ИИ.
 *
 * @param {object} address     - обектът address от отговора на геокодера
 * @param {string} displayName - display_name от същия отговор (резервен вариант)
 * @returns {string|null} ключът на района или null
 */
export function resolveDistrictFromGeo(address, displayName) {
  const addr = address && typeof address === 'object' ? address : {};

  // 1) Проверка на познатите ключове в подредба по достоверност.
  for (const key of GEO_DISTRICT_KEYS) {
    const hit = resolveDistrictKey(addr[key]);
    if (hit) return hit;
  }

  // 2) Сканиране на всички останали стойности - независимо от името на ключа.
  for (const value of Object.values(addr)) {
    if (typeof value !== 'string') continue;
    const hit = resolveDistrictKey(value);
    if (hit) return hit;
  }

  // 3) Последен вариант: пълният адресен низ ("..., Южен, Пловдив, ...").
  return resolveDistrictKey(displayName);
}

export function resolveCategoryKey(input) {
  const text = normalize(input);
  if (!text) return null;
  if (Object.prototype.hasOwnProperty.call(CATEGORIES, text)) return text;
  for (const [key, def] of Object.entries(CATEGORIES)) {
    if (normalize(def.label) === text) return key;
  }
  return null;
}

export function resolveEnterpriseEmail(input) {
  if (!input) return null;
  const email = INSTITUTION_INDEX.get(normalizeInstitution(input));
  return isValidEmail(email) ? email : null;
}

// -----------------------------------------------------------------------------
// 6. ОСНОВНА ФУНКЦИЯ ЗА МАРШРУТИЗАЦИЯ
// -----------------------------------------------------------------------------
/**
 * @param {object} args
 * @param {string} [args.category]                 - ключ или етикет на категорията
 * @param {string} [args.district]                 - район на инцидента
 * @param {string} [args.location]                 - адресът (за улица/булевард)
 * @param {string} [args.streetClass]              - подсказка от ИИ: 'boulevard'|'local'
 * @param {string} [args.assignedInstitution]      - резервен път към ОП
 * @param {string} [args.centralMunicipalityEmail] - Община Пловдив (главни булеварди)
 * @param {string} [args.fallbackEmail]            - краен резервен адрес
 * @param {string} [args.overrideEmail]            - ако е зададен, ВСИЧКО отива само там
 *
 * @returns {{to: string[], cc: string[], resolution: object}}
 */
export function resolveRouting({
  category,
  district,
  geoDistrict,
  location,
  streetClass,
  assignedInstitution,
  centralMunicipalityEmail,
  fallbackEmail,
  overrideEmail,
} = {}) {
  // Аргументът позволява подмяна през променлива на средата; при липса или
  // невалидна стойност се използва официалният адрес на Община Пловдив.
  const central = isValidEmail(centralMunicipalityEmail)
    ? centralMunicipalityEmail.trim()
    : CENTRAL_MUNICIPALITY.email;
  const fallback = isValidEmail(fallbackEmail) ? fallbackEmail.trim() : null;

  const categoryKey = resolveCategoryKey(category);
  const categoryDef = categoryKey ? CATEGORIES[categoryKey] : null;
  // Приоритет: геокодерът (реални координати) > предположението на ИИ >
  // името на институцията. Координатите са най-достоверни, защото не зависят
  // от това дали ИИ познава в кой район се намира дадена улица.
  const geoDistrictKey = resolveDistrictKey(geoDistrict);
  const districtKey = geoDistrictKey
    || resolveDistrictKey(district)
    || resolveDistrictKey(assignedInstitution);
  const districtSource = geoDistrictKey ? 'geo'
    : (resolveDistrictKey(district) ? 'ai'
    : (resolveDistrictKey(assignedInstitution) ? 'institution' : null));
  const districtEmail = districtKey && isValidEmail(DISTRICTS[districtKey].email)
    ? DISTRICTS[districtKey].email
    : null;

  const streetType = classifyStreet(location, streetClass);

  // ---- To: КОМПЕТЕНТЕН АДМИНИСТРАТИВЕН ОРГАН -------------------------------
  let to = null;
  let authorityType = null;
  let authorityLabel = null;

  if (streetType === 'boulevard' && central) {
    // Главен булевард -> Община Пловдив (централно).
    to = central;
    authorityType = 'central';
    authorityLabel = 'Община Пловдив';
  } else if (districtEmail) {
    // Местна улица -> съответното районно кметство.
    to = districtEmail;
    authorityType = 'district';
    authorityLabel = DISTRICTS[districtKey].label;
  } else if (central) {
    // Районът е неизвестен -> централната администрация поема преписката.
    to = central;
    authorityType = 'central';
    authorityLabel = 'Община Пловдив';
  } else if (fallback) {
    to = fallback;
    authorityType = 'fallback';
    authorityLabel = null;
  }

  // ---- Cc: СПЕЦИАЛИЗИРАНО ОБЩИНСКО ПРЕДПРИЯТИЕ -----------------------------
  let cc = null;
  let enterpriseLabel = null;

  if (categoryDef && categoryDef.enterprise) {
    const enterprise = ENTERPRISES[categoryDef.enterprise];
    if (enterprise && isValidEmail(enterprise.email)) {
      cc = enterprise.email;
      enterpriseLabel = enterprise.name;
    }
  }

  // Резервно: ОП по името, върнато от ИИ в assigned_institution.
  if (!cc) {
    const byName = resolveEnterpriseEmail(assignedInstitution);
    if (byName) {
      cc = byName;
      const match = Object.values(ENTERPRISES).find(e => e.email === byName);
      enterpriseLabel = match ? match.name : null;
    }
  }

  // Никога не дублираме един и същ адрес в To и Cc.
  if (cc && to && cc.toLowerCase() === to.toLowerCase()) {
    cc = null;
    enterpriseLabel = null;
  }

  const overrideActive = Boolean(overrideEmail && isValidEmail(overrideEmail));

  return {
    to: overrideActive ? [overrideEmail.trim()] : (to ? [to] : []),
    cc: overrideActive ? [] : (cc ? [cc] : []),
    resolution: {
      categoryKey,
      categoryLabel: categoryDef ? categoryDef.label : null,
      districtKey,
      districtLabel: districtKey ? DISTRICTS[districtKey].label : null,
      districtSource,             // 'geo' | 'ai' | 'institution' | null
      streetType,                 // 'boulevard' | 'local'
      authorityType,              // 'district' | 'central' | 'fallback' | null
      authorityLabel,             // кой орган образува преписката (To)
      enterpriseLabel,            // кое ОП е уведомено (Cc)
      intendedTo: to,
      intendedCc: cc,
      overrideActive,
      usedFallback: authorityType === 'fallback',
    },
  };
}

/** Списъци за подсказката към ИИ. */
export const CATEGORY_KEYS = Object.keys(CATEGORIES);
export const DISTRICT_LABELS = Object.values(DISTRICTS).map(d => d.label);
