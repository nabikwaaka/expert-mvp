"use client";
// -----------------------------------------------------------------------------
// MVP Wiring — API, данные и страница эксперта (однофайловый прототип)
// -----------------------------------------------------------------------------
// ✅ Цели файла:
// - Устранить ошибки сборки (useHashRoute undefined, синтаксис) и стабилизировать seed
// - Дать рабочий E2E: каталог → эксперт → слот → «оплата»(демо) → success + .ics + отзыв
// - Добавить минимальную аналитику событий и страницу логов (#/logs)
// - Экран диагностики (#/qa) с автотестами (это наши «тест‑кейсы» в рантайме)
// - TODO‑маркеры на Stripe/Kaspi, Meet API, реальную БД и Auth
// -----------------------------------------------------------------------------
// NOTE: один модуль, без внешних импортов UI. Tailwind‑классы — просто имена классов.
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from 'react';

// ---- UI helpers (polish) ----------------------------------------------------
const cx = (...xs:any[]) => xs.filter(Boolean).join(' ');
const Card = ({children, className=''}:{children:any;className?:string}) => (
  <div className={cx('rounded-2xl border bg-white p-5 shadow-sm hover:shadow transition', className)}>{children}</div>
);
const Badge = ({children, tone='default'}:{children:any; tone?:'default'|'charity'}) => (
  <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none', tone==='charity' && 'border-emerald-300 bg-emerald-50 text-emerald-700')}>{children}</span>
);
const Heart = () => (<svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true"><path d="M12 21s-6.2-4.35-9.33-7.47A5.93 5.93 0 1 1 12 5.1a5.93 5.93 0 1 1 9.33 8.43C18.2 16.65 12 21 12 21Z" fill="currentColor"/></svg>);

// Charity meta derived non‑destructively (works even if seed не содержит полей)
function getCharityMeta(e:any){
  // приоритет: явные поля
  if(typeof e?.donationPercent === 'number'){
    return { percent: Math.max(0, Math.min(100, e.donationPercent)), fund: e?.charityFund };
  }
  // мягкая эвристика для демо (чтобы были бейджи без правки seed)
  if(typeof e?.slug === 'string'){
    if(/startups?-1$|startup-mentor/.test(e.slug)) return { percent:100, fund:'Дар' };
    if(/career-2$|career-coach/.test(e.slug)) return { percent:50, fund:'Ayala' };
  }
  return { percent:0, fund: undefined };
}

// -----------------------------------------------------------------------------
// «lib/db.ts» — In‑Memory DB + утилиты
// -----------------------------------------------------------------------------
const db = {
  experts: new Map<string, any>(),
  slots: new Map<string, any>(),
  bookings: new Map<string, any>(),
  reviews: new Map<string, any>(),
  logs: new Map<string, any>(),
  leads: new Map<string, any>() // ← сбор лидов для прогрева
};

const uid = (prefix = 'id') => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
const formatKZT = (n: number) => new Intl.NumberFormat('ru-RU').format(n || 0);

// Безопасная генерация временной Meet‑ссылки по bookingId
function createTempMeetLink(bookingId: string) {
  const raw = (typeof bookingId === 'string' && bookingId.length) ? bookingId : 'fallback';
  const safe = raw.replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(9, 'x').slice(0, 9);
  return `https://meet.google.com/${safe.slice(0, 3)}-${safe.slice(3, 6)}-${safe.slice(6, 9)}`;
}

const listExperts = () => Array.from(db.experts.values());
const getExpertBySlug = (slug: string) => Array.from(db.experts.values()).find(e => e.slug === slug) || null;
const listSlotsForExpert = (expertId: string) => Array.from(db.slots.values()).filter(s => s.expertId === expertId && !s.isBooked);
const listReviewsForExpert = (expertId: string) => Array.from(db.reviews.values()).filter(r => r.expertId === expertId);
const getAvgRatingForExpert = (expertId: string) => {
  const rs = listReviewsForExpert(expertId);
  if (rs.length === 0) return null;
  return rs.reduce((acc, r) => acc + (Number(r.rating) || 0), 0) / rs.length;
};

// -----------------------------------------------------------------------------
// Категории/топики и утилиты фильтрации
// -----------------------------------------------------------------------------
const CATEGORIES = [
  { key: 'startups', name: 'Стартапы' },
  { key: 'career',   name: 'Карьера' },
  { key: 'religion', name: 'Религия' },
  { key: 'beauty',   name: 'Бьюти' },
  { key: 'business', name: 'Бизнес/Маркетинг' },
] as const;
const CATEGORY_TOPICS: Record<string, string[]> = {
  startups: ['Стартапы','Фандрайзинг','GTM'],
  career:   ['Карьера','HR','Интервью'],
  religion: ['Религия','Личное'],
  beauty:   ['Бьюти','Wellness'],
  business: ['Бизнес','Маркетинг','Продажи'],
};
function categoryDisplayName(key:string){ return CATEGORIES.find(c=>c.key===key)?.name || key; }
function expertMatchesCategoryKey(e:any, key:string){
  const tags = CATEGORY_TOPICS[key]||[];
  return Array.isArray(e?.topics) && e.topics.some((t:string)=> tags.includes(t));
}

// Email‑валидация и .ics экспорт
const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
const icsEncode = (s: string) => (s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[;,]/g, m => m === ',' ? '\\,' : '\\;');
function makeICSDataUrl(bookingId: string) {
  const b = db.bookings.get(bookingId); if (!b) return null;
  const slot = db.slots.get(b.slotId); if (!slot) return null;
  const expert = db.experts.get(b.expertId) || { name: 'Эксперт' };
  const dt = new Date(slot.startsAt);
  const dtUtc = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const durMin = slot.minutes || 30;
  const uidVal = `${bookingId}@ourapp.local`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OurApp//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsEncode(uidVal)}`,
    `DTSTAMP:${dtUtc}`,
    `DTSTART:${dtUtc}`,
    `DURATION:PT${durMin}M`,
    `SUMMARY:${icsEncode('Встреча с экспертом — ' + (expert.name || ''))}`,
    `DESCRIPTION:${icsEncode('Ссылка Meet: ' + (b.meetUrl || createTempMeetLink(bookingId)))}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const base64 = typeof btoa !== 'undefined' ? btoa(unescape(encodeURIComponent(lines))) : '';
  return { filename: `meeting_${bookingId}.ics`, dataUrl: `data:text/calendar;base64,${base64}` };
}

// -----------------------------------------------------------------------------
// seed() — наполняет демо‑данные; ensureSeeded() — гарантирует seed ДО доступа
// -----------------------------------------------------------------------------
let __seedDone = false;
function seed() {
  if (__seedDone) return;
  const base = [
    { id: 'exp_demo',    slug: 'demo-expert',    name: 'Имя Эксперта',       bio: '7+ лет в маркетинге и продукте. Помогаю собрать питч и найти точки роста.', city: 'Алматы',  langs: ['RU', 'EN'], topics: ['Питч', 'Маркетинг'], price: [{ minutes: 30, amount: 25000 }], rating: 4.9 },
    { id: 'exp_startup', slug: 'startup-mentor', name: 'Ментор по стартапам', bio: 'Основатель 2 стартапов, экс-VC. Помогу с GTM и unit‑экономикой.',           city: 'Астана',  langs: ['RU', 'KZ', 'EN'], topics: ['Стартапы', 'Фандрайзинг', 'GTM'], price: [{ minutes: 30, amount: 50000 }], rating: 4.8 },
    { id: 'exp_career',  slug: 'career-coach',   name: 'Карьера & Резюме',    bio: 'HRD 10+ лет. Карьера, резюме, подготовка к интервью.',                    city: 'Алматы',  langs: ['RU'],           topics: ['Карьера', 'HR', 'Интервью'],    price: [{ minutes: 30, amount: 40000 }], rating: 4.7 },
    { id: 'exp_relig',   slug: 'faith-mentor',   name: 'Духовный наставник',  bio: 'Беседы о вере, смысле и выборе пути. Бережно и конфиденциально.',         city: 'Шымкент', langs: ['RU', 'KZ'],     topics: ['Религия', 'Личное'],          price: [{ minutes: 30, amount: 30000 }], rating: 4.95 },
    { id: 'exp_beauty',  slug: 'beauty-expert',  name: 'Бьюти‑эксперт',       bio: 'Скин‑рутина, уход, подбор средств. Без рекламы — только опыт.',            city: 'Алматы',  langs: ['RU'],           topics: ['Бьюти', 'Wellness'],          price: [{ minutes: 30, amount: 35000 }], rating: 4.6 },
  ];
  for (const e of base) db.experts.set(e.id, e);

  // Автогенерация дополнительных экспертов по категориям (итого >=20)
  const gens = [
    { key:'startups', count:4, city:'Астана',  langs:['RU','EN'], price:50000,  bio:'Стартапы, фандрайзинг, GTM.' },
    { key:'career',   count:4, city:'Алматы',  langs:['RU'],      price:40000,  bio:'Карьера, резюме, интервью.' },
    { key:'religion', count:3, city:'Шымкент', langs:['RU','KZ'], price:30000,  bio:'Духовные беседы. Конфиденциально.' },
    { key:'beauty',   count:4, city:'Алматы',  langs:['RU'],      price:35000,  bio:'Бьюти и wellness без рекламы.' },
    { key:'business', count:4, city:'Алматы',  langs:['RU'],      price:45000,  bio:'Маркетинг, продажи, бизнес‑процессы.' },
  ];
  gens.forEach(g=>{
    for(let i=1;i<=g.count;i++){
      const id = `exp_${g.key}_${i}`;
      const slug = `${g.key}-${i}`;
      const topics = CATEGORY_TOPICS[g.key];
      const name = `Эксперт ${i} · ${categoryDisplayName(g.key)}`;
      const rating = 4.6 + (i%4)*0.1; // 4.6..4.9
      db.experts.set(id, { id, slug, name, bio:g.bio, city:g.city, langs:g.langs, topics, price:[{minutes:30, amount:g.price}], rating });
    }
  });

  // Слоты для всех экспертов
  const now = Date.now();
  for (const e of db.experts.values()) {
    [6, 12, 24].forEach(h => {
      const id = uid('slot');
      db.slots.set(id, { id, expertId: e.id, startsAt: new Date(now + h * 3600 * 1000).toISOString(), minutes: 30, isBooked: false });
    });
  }
  __seedDone = true;
}
function ensureSeeded() { if (!__seedDone || db.experts.size === 0) seed(); }
ensureSeeded();

// -----------------------------------------------------------------------------
// Router utils
// -----------------------------------------------------------------------------
function useHashRoute(){
  const [hash, setHash] = useState(typeof location!=='undefined' ? (location.hash||'#/') : '#/');
  useEffect(()=>{
    const onHash = ()=> setHash(location.hash||'#/');
    if(typeof window!=='undefined') window.addEventListener('hashchange', onHash);
    return ()=> { if(typeof window!=='undefined') window.removeEventListener('hashchange', onHash); };
  },[]);
  return hash;
}
function parseHash(){
  const h = typeof location!=='undefined' ? (location.hash||'#/') : '#/' ;
  const [path, q] = h.split('?');
  const qs = new URLSearchParams(q||'');
  return { path, qs };
}

// -----------------------------------------------------------------------------
// Analytics logger (very lightweight)
// -----------------------------------------------------------------------------
function track(event: string, detail: any = {}) {
  try {
    const id = uid('log');
    db.logs.set(id, { id, event, detail, createdAt: new Date().toISOString() });
  } catch {}
}
const listLogs = () => Array.from(db.logs.values()).sort((a,b)=> (a.createdAt<b.createdAt?1:-1));

// ---- Metrics & Export helpers ----------------------------------------------
function computeMetrics(){
  const logs = listLogs();
  const bookings = Array.from(db.bookings.values());
  const viewsLanding = logs.filter(l=>l.event==='view_landing').length;
  const viewsCatalog = logs.filter(l=>l.event==='view_catalog').length;
  const viewsExpert  = logs.filter(l=>l.event==='view_expert').length;
  const selects      = logs.filter(l=>l.event==='select_slot').length;
  const checkouts    = logs.filter(l=>l.event==='start_checkout').length;
  const pays         = logs.filter(l=>l.event==='pay_success').length;

  const paid = bookings.filter((b:any)=> b.status==='paid');
  const revenue = paid.reduce((s:number,b:any)=> s + (b.priceKZT||0), 0);
  const emails = new Set<string>();
  for(const b of paid){ if(b?.clientEmail) emails.add(String(b.clientEmail).toLowerCase()); }
  const uniqueBuyers = emails.size;
  // ретеншн: покупатели с >=2 оплатами
  const countsByEmail: Record<string, number> = {};
  for(const b of paid){ const e=(b?.clientEmail||'').toLowerCase(); if(!e) continue; countsByEmail[e]=(countsByEmail[e]||0)+1; }
  const repeatBuyers = Object.values(countsByEmail).filter(n=>n>=2).length;

  function pct(x:number, y:number){ return y>0 ? Math.round((x/y)*1000)/10 : 0; }

  return {
    viewsLanding, viewsCatalog, viewsExpert,
    selects, checkouts, pays,
    revenue,
    uniqueBuyers,
    repeatBuyers,
    rate_view_to_select: pct(selects, Math.max(viewsExpert, viewsCatalog)),
    rate_select_to_checkout: pct(checkouts, selects),
    rate_checkout_to_pay: pct(pays, checkouts),
    rate_view_to_pay: pct(pays, Math.max(viewsExpert, viewsCatalog)),
    arpu: uniqueBuyers>0? Math.round(revenue/uniqueBuyers) : 0,
  };
}

function exportLogsAsCSV(){
  const header = ["id","createdAt","event","detail"];
  const rows: string[][] = [header];
  for(const l of listLogs()){
    const detail = JSON.stringify(l.detail||{}).replaceAll('"','""');
    rows.push([String(l.id), String(l.createdAt), String(l.event), `"${detail}"`]);
  }
  // ВАЖНО: строки CSV соединяем через \n — это устраняет ошибку unterminated string
  const csv = rows.map(r => r.join(',')).join('\n');
  const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  const filename = `logs_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
  return { filename, dataUrl };
}
function exportLogsAsJSON(){
  const data = JSON.stringify(listLogs(), null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(data)}`;
  const filename = `logs_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
  return { filename, dataUrl };
}

// -----------------------------------------------------------------------------
// UI: NavBar
// -----------------------------------------------------------------------------
function NavBar(){
  const { path } = parseHash();
  const showBack = path !== '#/' && path !== '#/experts';
  return (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur border-b">
      <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {showBack && (
            <button
              onClick={()=>{ location.hash = '#/experts'; }}
              className="inline-flex items-center justify-center h-9 w-9 rounded-full border hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/20"
              aria-label="Назад"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
          <a href="#/" className="font-semibold hover:opacity-80">[Название]</a>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <a href="#/experts" className="hover:opacity-80">Эксперты</a>
          <a href="#/leads" className="hover:opacity-80">Бета‑тест</a>
          <a href="#/apply" className="hover:opacity-80">Стать экспертом</a>
          <a href="#/dash/client" className="hover:opacity-80">Мои встречи</a>
        </nav>
      </div>
    </header>
  );
}

// -----------------------------------------------------------------------------
// Landing
// -----------------------------------------------------------------------------
function LandingPage(){
  ensureSeeded();
  useEffect(()=>{ track('view_landing', {}); },[]);
  const experts:any[] = listExperts();
  const sorted = [...experts].sort((a,b)=> (getCharityMeta(b).percent===100?1:0) - (getCharityMeta(a).percent===100?1:0)).reverse();
  const top20 = sorted.slice(0,20);
  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      {/* Hero */}
      <section className="py-8 md:py-14">
        <h1 className="text-3xl md:text-5xl font-bold leading-tight">Быстрый доступ к опыту людей, которые уже проходили этот путь</h1>
        <p className="mt-4 text-gray-600 max-w-2xl">Совет, коучинг, питч, просто поговорить — найдите эксперта, бронируйте слот и созвонитесь онлайн. Удобно с телефона.</p>
        <div className="mt-6 flex gap-3 flex-wrap">
          <a href="#/experts" className="rounded-2xl bg-black text-white px-5 py-3 font-semibold">Выбрать эксперта</a>
          <a href="#/dash/client" className="rounded-2xl border px-5 py-3">Мои встречи</a>
          <a href="#/leads" className="rounded-2xl border px-5 py-3">Стать бета‑тестером</a>
        </div>
      </section>

      {/* Категории */}
      <section className="mt-8">
        <h2 className="text-xl font-semibold">Направления</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {CATEGORIES.map(c=> (
            <a key={c.key} href={`#/experts?topic=${c.key}`} className="rounded-full border px-3 py-1.5 text-sm hover:bg-gray-50">{c.name}</a>
          ))}
        </div>
      </section>

      {/* 20 экспертов */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">Эксперты (20)</h2>
          <a href="#/experts" className="text-sm underline">Показать всех</a>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {top20.map((e:any)=> {
            const ch = getCharityMeta(e);
            return (
              <a key={e.id} href={`#/expert/${e.slug}`} className="block">
                <Card>
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold">{e.name}</div>
                    {ch.percent>0 && (
                      <Badge tone={ch.percent===100?'charity':'default'}><Heart/> {ch.percent}%</Badge>
                    )}
                  </div>
                  <div className="text-sm text-gray-600 line-clamp-2 mt-1">{e.bio}</div>
                  <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
                    <span>₸ {formatKZT(e.price?.[0]?.amount||0)} / 30 мин</span>
                    <span className="inline-flex items-center gap-1"><span aria-hidden>⭐</span> {Number(e.rating||0).toFixed(1)}</span>
                  </div>
                  {ch.percent>0 && ch.fund && (<div className="mt-2 text-xs text-emerald-700">Поддерживает фонд «{ch.fund}»</div>)}
                </Card>
              </a>
            );
          })}
        </div>
      </section>

      {/* Sticky CTA для мобилы на лендинге */}
      <div className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t p-3">
        <a href="#/experts" className="block w-full rounded-2xl bg-black text-white text-center py-3 font-semibold">Найти эксперта</a>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Experts list
// -----------------------------------------------------------------------------
function ExpertsPage(){
  ensureSeeded();
  const { qs } = parseHash();
  const topicKey = qs.get('topic') || 'all';
  const all:any[] = listExperts();
  const filtered = topicKey==='all' ? all : all.filter(e=> expertMatchesCategoryKey(e, topicKey));
  const experts = [...filtered].sort((a,b)=> getCharityMeta(b).percent - getCharityMeta(a).percent);
  useEffect(()=>{ track('view_catalog', { topicKey, count: experts.length }); },[topicKey, experts.length]);
  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Эксперты {topicKey!=='all' && (<span className="text-gray-500 text-base">· {categoryDisplayName(topicKey)}</span>)}</h1>
        <div className="text-sm text-gray-500">Найдено: {experts.length}</div>
      </div>

      {/* Фильтр */}
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={`#/experts`} className={`rounded-full border px-3 py-1.5 text-sm ${topicKey==='all'?'bg-black text-white':'hover:bg-gray-50'}`}>Все</a>
        {CATEGORIES.map(c=> (
          <a key={c.key} href={`#/experts?topic=${c.key}`} className={`rounded-full border px-3 py-1.5 text-sm ${topicKey===c.key?'bg-black text-white':'hover:bg-gray-50'}`}>{c.name}</a>
        ))}
      </div>

      {/* Сетка */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {experts.map((e:any)=> {
          const ch = getCharityMeta(e);
          return (
            <a key={e.id} href={`#/expert/${e.slug}`} className="block">
              <Card>
                <div className="flex items-start justify-between gap-2">
                  <div className="font-semibold">{e.name}</div>
                  {ch.percent>0 && (<Badge tone={ch.percent===100?'charity':'default'}><Heart/> {ch.percent}%</Badge>)}
                </div>
                <div className="text-sm text-gray-600 line-clamp-2 mt-1">{e.bio}</div>
                <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
                  <span>₸ {formatKZT(e.price?.[0]?.amount||0)} / 30 мин</span>
                  <span className="inline-flex items-center gap-1"><span aria-hidden>⭐</span> {Number(e.rating||0).toFixed(1)}</span>
                </div>
                {ch.percent>0 && ch.fund && (<div className="mt-2 text-xs text-emerald-700">Поддерживает фонд «{ch.fund}»</div>)}
              </Card>
            </a>
          );
        })}
        {experts.length===0 && (
          <div className="text-sm text-gray-500">Нет экспертов в этой категории</div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Expert page + booking widget
// -----------------------------------------------------------------------------
function ExpertPage({ slug }:{slug:string}){
  ensureSeeded();
  const expert = getExpertBySlug(slug);
  if(!expert) return <div className="mx-auto max-w-7xl px-4 py-10">Эксперт не найден.</div>;
  const avg = getAvgRatingForExpert(expert.id);
  const reviews = listReviewsForExpert(expert.id).slice(-3).reverse();
  const price = expert.price?.[0]?.amount||0;
  const ch = getCharityMeta(expert);
  useEffect(()=>{ track('view_expert', { expertId: expert.id, slug }); },[slug]);
  return (
    <>
      <div className="mx-auto max-w-7xl px-4 py-10 grid gap-6 md:grid-cols-[1fr_380px]">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">{expert.name} {ch.percent>0 && (<Badge tone={ch.percent===100?'charity':'default'}><Heart/> {ch.percent}%</Badge>)}</h1>
          <div className="mt-1 text-sm text-gray-600 flex items-center gap-2">
            {avg ? (
              <>
                <span className="inline-flex items-center gap-1"><span aria-hidden>⭐</span> {avg.toFixed(1)}</span>
                <span className="text-gray-400">({listReviewsForExpert(expert.id).length} отзывов)</span>
              </>
            ) : (
              <span className="text-gray-500">Рейтинг появится после первых отзывов</span>
            )}
          </div>
          <p className="mt-3 text-gray-700">{expert.bio}</p>
          {ch.percent>0 && (
            <div className="mt-3 text-xs text-emerald-700">Делится {ch.percent}% гонорара{ch.fund? ` • фонд «${ch.fund}»`:''}</div>
          )}
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-gray-600">
            {(expert.topics||[]).map((t:string)=>(<span key={t} className="rounded-full border px-2 py-1">{t}</span>))}
          </div>

          {reviews.length>0 && (
            <div className="mt-8">
              <h2 className="text-lg font-semibold">Последние отзывы</h2>
              <div className="mt-3 grid gap-3">
                {reviews.map((r:any)=> (
                  <div key={r.id} className="rounded-2xl border bg-white p-4">
                    <div className="text-sm"><span aria-hidden>⭐</span> {r.rating} · <span className="text-gray-500">{new Date(r.createdAt).toLocaleDateString('ru-RU')}</span></div>
                    {r.comment && <div className="mt-1 text-sm text-gray-700">{r.comment}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <ExpertBookingWidget expertId={expert.id}/>
      </div>

      {/* Sticky CTA для мобилы */}
      <div className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t p-3">
        <a href="#booking" className="block w-full rounded-2xl bg-black text-white text-center py-3 font-semibold">Забронировать · ₸ {formatKZT(price)}</a>
      </div>
    </>
  );
}

function ExpertBookingWidget({ expertId }:{expertId:string}){
  const [slotId,setSlotId]=useState<string|null>(null);
  const [name,setName]=useState('');
  const [email,setEmail]=useState('');
  const [loading,setLoading]=useState(false);
  const slots:any[] = useMemo(()=> listSlotsForExpert(expertId) as any[],[expertId]);
  const price = db.experts.get(expertId)?.price?.[0]?.amount || 0;

  // Prefill из localStorage
  useEffect(()=>{
    try{
      const raw = localStorage.getItem('guestProfile');
      if(raw){ const p = JSON.parse(raw); if(p?.name) setName(p.name); if(p?.email) setEmail(p.email); }
    }catch{}
  },[]);
  useEffect(()=>{
    try{ localStorage.setItem('guestProfile', JSON.stringify({name, email})); }catch{}
  },[name,email]);

  async function handlePay(){
    if(!slotId) return;
    setLoading(true);
    const bookingId = uid('bk');
    db.bookings.set(bookingId, { id:bookingId, slotId, expertId, clientId:'guest_demo', clientName:name||'Гость', clientEmail:email||'guest@example.com', priceKZT:price, status:'pending' });
    track('start_checkout', { bookingId, expertId, slotId, priceKZT: price });
    location.hash = `#/checkout?booking=${bookingId}`;
  }

  return (
    <div id="booking" className="rounded-3xl bg-white border p-6 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold">Забронировать встречу</h2>
        <div className="text-2xl font-semibold">₸ {formatKZT(price)}</div>
      </div>
      <div className="mt-4 grid gap-3">
        <input className="rounded-xl border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/20" placeholder="Ваше имя" value={name} onChange={e=>setName((e.target as HTMLInputElement).value)} />
        <input className="rounded-xl border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/20" placeholder="Email" value={email} onChange={e=>setEmail((e.target as HTMLInputElement).value)} />
      </div>
      <div className="mt-4">
        <div className="text-sm text-gray-600 mb-2">Свободные слоты</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {slots.map(s=> (
            <button key={s.id} onClick={()=>{ setSlotId(s.id); track('select_slot', { expertId, slotId: s.id, startsAt: s.startsAt }); }} className={`rounded-xl border px-4 py-3 text-left transition focus:outline-none focus:ring-2 focus:ring-black/15 ${slotId===s.id?'border-black bg-gray-50 shadow-sm':'hover:bg-gray-50'}`}>
              <div className="text-[11px] uppercase tracking-wide text-gray-500">{new Date(s.startsAt).toLocaleDateString('ru-RU',{weekday:'short',day:'2-digit',month:'2-digit'})}</div>
              <div className="text-base">{new Date(s.startsAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</div>
            </button>
          ))}
          {slots.length===0 && <div className="text-sm text-gray-500">Нет доступных слотов</div>}
        </div>
      </div>
      <button onClick={handlePay} disabled={!slotId || !isValidEmail(email) || name.trim().length<2 || loading} className={`mt-4 w-full rounded-2xl py-3 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-black/20 ${(!slotId||loading||!isValidEmail(email)||name.trim().length<2)?'bg-gray-200 text-gray-400 cursor-not-allowed':'bg-black text-white hover:opacity-90'}`}>{loading?'Подождите…':'Забронировать и оплатить'}</button>
      {(!isValidEmail(email)||name.trim().length<2) && <p className="mt-2 text-center text-xs text-rose-600">Укажите имя и корректный email, чтобы продолжить</p>}
      <p className="mt-2 text-center text-xs text-gray-500">Google Meet‑ссылка придёт на почту после оплаты</p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Checkout / Success
// -----------------------------------------------------------------------------
function CheckoutPage({ bookingId }:{bookingId:string}){
  const booking = db.bookings.get(bookingId)||null;
  if(!booking) return <div className="mx-auto max-w-sm px-4 py-10">Бронирование не найдено</div>;
  const [paying,setPaying]=useState(false);
  function payNow(){
    if(paying) return; setPaying(true);
    const slot = db.slots.get(booking.slotId);
    if(slot){ slot.isBooked = true; db.slots.set(slot.id, slot); }
    booking.status = 'paid';
    booking.meetUrl = createTempMeetLink(booking.id);
    db.bookings.set(booking.id, booking);
    track('pay_success', { bookingId, expertId: booking.expertId, priceKZT: booking.priceKZT });
    location.hash = `#/success?booking=${bookingId}`;
  }
  return (
    <div className="min-h-[70vh] grid place-items-center px-4">
      <div className="w-full max-w-sm rounded-3xl border shadow-sm bg-white p-6">
        <div className="text-lg font-semibold">Оплата (демо)</div>
        <div className="mt-2 text-sm text-gray-600">Сумма: ₸ {formatKZT(booking.priceKZT)}</div>
        <button className="mt-4 w-full rounded-2xl bg-black text-white py-3 font-semibold focus:outline-none focus:ring-2 focus:ring-black/20" onClick={payNow} disabled={paying}>{paying?'Оплата…':'Оплатить (демо)'}</button>
        <button className="mt-2 w-full rounded-2xl border py-2 focus:outline-none focus:ring-2 focus:ring-black/10" onClick={()=>{ location.hash = '#/experts'; }}>Отмена</button>
      </div>
    </div>
  );
}

function SuccessPage({ bookingId }:{bookingId:string}){
  const b = db.bookings.get(bookingId) || null;
  if(!b) return <div className="mx-auto max-w-sm px-4 py-10">Бронирование не найдено</div>;
  const slot = db.slots.get(b.slotId);
  const meet = b.meetUrl || createTempMeetLink(bookingId);
  const whenStr = slot ? new Date(slot.startsAt).toLocaleString('ru-RU') : '—';
  const ics = makeICSDataUrl(bookingId);

  // Отзыв после встречи (MVP — сразу на success)
  const [rating,setRating] = useState<number|undefined>();
  const [comment,setComment] = useState('');
  const [saved,setSaved] = useState(false);
  function saveReview(){
    if(!rating) return;
    const id = uid('rev');
    db.reviews.set(id, { id, bookingId, expertId: b.expertId, rating, comment: comment.trim(), createdAt: new Date().toISOString() });
    setSaved(true);
  }

  return (
    <div className="min-h-[70vh] grid place-items-center px-4">
      <div className="w-full max-w-md rounded-3xl border shadow-sm bg-white p-6">
        <div className="text-lg font-semibold">Встреча подтверждена</div>
        <div className="mt-2 text-sm">Когда: {whenStr}</div>
        <div className="mt-3 rounded-xl bg-gray-50 p-3 text-sm">Meet: <a className="underline" href={meet} target="_blank" rel="noreferrer">{meet}</a></div>
        {ics && (
          <a className="mt-3 inline-flex items-center justify-center rounded-2xl border px-4 py-2 text-sm hover:bg-gray-50" download={ics.filename} href={ics.dataUrl}>Добавить в календарь (.ics)</a>
        )}

        <div className="mt-6 border-t pt-5">
          <div className="font-semibold">Оцените встречу</div>
          <div className="mt-2 flex gap-2">
            {[1,2,3,4,5].map(n=> (
              <button key={n} onClick={()=>setRating(n)} className={`h-9 w-9 rounded-full border text-sm ${rating===n?'bg-black text-white':'hover:bg-gray-50'}`}>{n}</button>
            ))}
          </div>
          <textarea className="mt-3 w-full rounded-2xl border p-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/20" rows={3} placeholder="Короткий отзыв (необязательно)" value={comment} onChange={e=>setComment((e.target as HTMLTextAreaElement).value)} />
          <button onClick={saveReview} disabled={!rating||saved} className={`mt-2 rounded-2xl px-4 py-2 text-sm font-semibold ${(!rating||saved)?'bg-gray-200 text-gray-400 cursor-not-allowed':'bg-black text-white hover:opacity-90'}`}>{saved?'Сохранено':'Сохранить отзыв'}</button>
        </div>

        <a href="#/experts" className="mt-4 block text-center rounded-2xl bg-black text-white py-2 font-semibold focus:outline-none focus:ring-2 focus:ring-black/20">Вернуться к экспертам</a>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Lead capture (прогрев) + Apply + Dash (заглушки)
// -----------------------------------------------------------------------------
function LeadCapturePage(){
  const [name,setName]=useState('');
  const [email,setEmail]=useState('');
  const [topic,setTopic]=useState('startups');
  const [price,setPrice]=useState<string>('50000');
  const [notes,setNotes]=useState('');
  const [sent,setSent]=useState(false);
  function submit(){
    if(name.trim().length<2||!isValidEmail(email)) return;
    const id=uid('lead');
    const p=Number(price)||0;
    db.leads.set(id,{id,name,email:email.toLowerCase(),topic,priceKZT:p,notes,createdAt:new Date().toISOString()});
    track('lead_submit',{id,topic,priceKZT:p});
    setSent(true);
  }
  if(sent){
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <Card>
          <div className="text-lg font-semibold">Спасибо!</div>
          <p className="mt-2 text-sm text-gray-600">Мы свяжемся с вами, как только откроем доступ первым бета‑тестерам.</p>
          <a href="#/experts" className="mt-4 inline-flex rounded-2xl bg-black text-white px-4 py-2 text-sm">Перейти к экспертам</a>
        </Card>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold">Присоединиться к бета‑тесту</h1>
      <Card className="mt-4">
        <div className="grid gap-3">
          <input className="rounded-xl border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/20" placeholder="Ваше имя" value={name} onChange={e=>setName((e.target as HTMLInputElement).value)} />
          <input className="rounded-xl border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/20" placeholder="Email" value={email} onChange={e=>setEmail((e.target as HTMLInputElement).value)} />
          <select className="rounded-xl border px-3 py-2" value={topic} onChange={e=>setTopic((e.target as HTMLSelectElement).value)}>
            {CATEGORIES.map(c=> (<option key={c.key} value={c.key}>{c.name}</option>))}
          </select>
          <input className="rounded-xl border px-3 py-2" placeholder="Желаемая цена, ₸" value={price} onChange={e=>setPrice((e.target as HTMLInputElement).value)} />
          <textarea className="rounded-xl border px-3 py-2" rows={3} placeholder="Что ищете? (необязательно)" value={notes} onChange={e=>setNotes((e.target as HTMLTextAreaElement).value)} />
          <button onClick={submit} disabled={name.trim().length<2||!isValidEmail(email)} className={`rounded-2xl px-4 py-2 text-sm font-semibold ${ (name.trim().length<2||!isValidEmail(email))? 'bg-gray-200 text-gray-400 cursor-not-allowed':'bg-black text-white hover:opacity-90'}`}>Отправить</button>
        </div>
      </Card>
    </div>
  );
}

// Apply + Dash (заглушки)
// -----------------------------------------------------------------------------
function ApplyPage(){ return <div className="p-10">Форма заявки для эксперта (заглушка)</div>; }
function ExpertDashboard(){
  const experts:any[] = listExperts() as any[];
  const stats = experts.map(e=>{
    const bookings = Array.from(db.bookings.values()).filter(b=>b.expertId===e.id);
    const paid = bookings.filter(b=>b.status==='paid');
    const revenue = paid.reduce((sum:number, b:any)=> sum + (b.priceKZT||0), 0);
    return { id:e.id, name:e.name, load:paid.length, revenue };
  });
  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      <h1 className="text-2xl font-bold">Кабинет эксперта</h1>
      <div className="mt-6 rounded-2xl border bg-white p-6">
        <h2 className="font-semibold">Статистика (демо)</h2>
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-left border-b bg-gray-50"><th className="p-2">Эксперт</th><th className="p-2">Оплаченных встреч</th><th className="p-2">Доход (₸)</th></tr></thead>
          <tbody>
            {stats.map(s=> (<tr key={s.id} className="border-b last:border-0"><td className="p-2">{s.name}</td><td className="p-2">{s.load}</td><td className="p-2">{formatKZT(s.revenue)}</td></tr>))}
            {stats.length===0 && <tr><td className="p-2 text-gray-500" colSpan={3}>Пока нет данных</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function ClientDashboard(){
  const currentClientId = 'guest_demo';
  const bookings:any[] = Array.from(db.bookings.values()).filter(b=>b.clientId===currentClientId);
  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      <h1 className="text-2xl font-bold">Мои встречи</h1>
      <div className="mt-6 grid gap-4">
        {bookings.length===0 && (<div className="rounded-2xl border bg-white p-6 text-sm text-gray-600">У вас пока нет встреч. Перейдите в раздел «Эксперты», чтобы забронировать.</div>)}
        {bookings.map(b=>{
          const slot = db.slots.get(b.slotId);
          const expert = db.experts.get(b.expertId);
          const whenStr = slot? new Date(slot.startsAt).toLocaleString('ru-RU') : '—';
          return (
            <div key={b.id} className="rounded-2xl border bg-white p-6 flex items-center justify-between">
              <div>
                <div className="text-sm text-gray-600">{whenStr}</div>
                <div className="font-semibold">{expert?.name||'Эксперт'}</div>
                <div className="text-xs text-gray-500">Статус: {b.status}</div>
              </div>
              {b.status==='paid' && (<a className="rounded-2xl border px-4 py-2 text-sm hover:bg-gray-50" href={b.meetUrl} target="_blank" rel="noreferrer">Перейти в Meet</a>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Logs (analytics) + QA (self‑tests)
// -----------------------------------------------------------------------------
function LogsPage(){
  const m = computeMetrics();
  const csv = exportLogsAsCSV();
  const json = exportLogsAsJSON();
  const logs = listLogs();
  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      <h1 className="text-2xl font-bold">События и метрики (демо)</h1>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <div className="font-semibold">Основные метрики</div>
          <ul className="mt-2 text-sm text-gray-700 space-y-1">
            <li>Просмотры каталога/эксперта: {m.viewsCatalog}/{m.viewsExpert}</li>
            <li>Выбор слота → чекаут → оплата: {m.selects} → {m.checkouts} → {m.pays}</li>
            <li>CR (view→pay): {m.rate_view_to_pay}%</li>
            <li>CR (select→pay): {m.rate_checkout_to_pay}%</li>
            <li>Выручка: ₸ {formatKZT(m.revenue)} · ARPU: ₸ {formatKZT(m.arpu)}</li>
            <li>Покупатели (уникальные/повторные): {m.uniqueBuyers}/{m.repeatBuyers}</li>
          </ul>
          <div className="mt-3 flex gap-2">
            <a className="rounded-2xl border px-3 py-1.5 text-sm" download={csv.filename} href={csv.dataUrl}>Скачать CSV</a>
            <a className="rounded-2xl border px-3 py-1.5 text-sm" download={json.filename} href={json.dataUrl}>Скачать JSON</a>
          </div>
        </Card>
        <Card>
          <div className="font-semibold">Всего событий: {logs.length}</div>
          <div className="mt-2 max-h-[360px] overflow-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left border-b bg-gray-50"><th className="p-2">Время</th><th className="p-2">Событие</th><th className="p-2">Детали</th></tr></thead>
              <tbody>
                {logs.map(l=> (
                  <tr key={l.id} className="border-b last:border-0 align-top">
                    <td className="p-2 whitespace-nowrap">{new Date(l.createdAt).toLocaleTimeString('ru-RU')}</td>
                    <td className="p-2">{l.event}</td>
                    <td className="p-2 text-gray-500">{JSON.stringify(l.detail)}</td>
                  </tr>
                ))}
                {logs.length===0 && <tr><td className="p-2 text-gray-500" colSpan={3}>Событий пока нет</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

async function runMvpSelfTests(){
  const results: {name:string, ok:boolean, detail?:string}[] = [];
  try{
    // 0) seed присутствует до использования
    results.push({ name:'seed executed', ok: __seedDone && db.experts.size>=20, detail:`experts=${db.experts.size}` });

    // 1) базовые компоненты доступны
    results.push({ name:'LandingPage is function', ok: typeof LandingPage==='function' });
    results.push({ name:'ExpertBookingWidget is function', ok: typeof ExpertBookingWidget==='function' });

    // 2) meet‑link формат (включая пустой id)
    const link = createTempMeetLink('bk__');
    const link2 = createTempMeetLink('');
    const ok1 = /^https:\/\/meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/.test(link);
    const ok1b = /^https:\/\/meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/.test(link2);
    results.push({ name:'createTempMeetLink()', ok: ok1, detail: link });
    results.push({ name:'createTempMeetLink(empty)', ok: ok1b, detail: link2 });

    // 3) список экспертов ≥20 и фильтрация по категориям
    const experts = listExperts();
    results.push({ name:'experts seeded (>=20)', ok: Array.isArray(experts) && experts.length>=20, detail: `count=${experts.length}` });
    const keys = Object.keys(CATEGORY_TOPICS);
    for(const k of keys){
      const any = experts.some(e=> expertMatchesCategoryKey(e, k));
      results.push({ name:`category has experts: ${k}`, ok:any });
    }

    // 4) .ics генератор
    const sid = uid('slot');
    const exp = experts[0];
    db.slots.set(sid, { id:sid, expertId: exp.id, startsAt: new Date(Date.now()+3600e3).toISOString(), minutes:30, isBooked:false });
    const bid = uid('bk');
    db.bookings.set(bid, { id:bid, slotId:sid, expertId: exp.id, clientId:'qa', clientEmail:'qa@example.com', priceKZT:100, status:'paid', meetUrl:createTempMeetLink(bid) });
    const ics = makeICSDataUrl(bid);
    results.push({ name:'.ics generated', ok: !!ics && !!ics?.dataUrl, detail: ics?.filename });
  }catch(e:any){
    results.push({ name:'unexpected error', ok:false, detail:String(e?.message||e) });
  }
  return results;
}

function QAPage(){
  const [results,setResults] = useState<{name:string, ok:boolean, detail?:string}[]>([]);
  useEffect(()=>{ (async()=> setResults(await runMvpSelfTests()))(); },[]);
  const okCount = results.filter(r=>r.ok).length;
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-bold">Автотесты (runtime)</h1>
      <div className="mt-3 text-sm text-gray-600">Пройдено: {okCount}/{results.length}</div>
      <div className="mt-4 rounded-2xl border bg-white">
        <table className="w-full text-sm">
          <thead><tr className="text-left border-b bg-gray-50"><th className="p-2">Тест</th><th className="p-2">OK</th><th className="p-2">Детали</th></tr></thead>
          <tbody>
            {results.map((r,i)=> (
              <tr key={i} className="border-b last:border-0"><td className="p-2">{r.name}</td><td className="p-2">{r.ok?'✅':'❌'}</td><td className="p-2 text-gray-500">{r.detail||''}</td></tr>
            ))}
            {results.length===0 && <tr><td className="p-2 text-gray-500" colSpan={3}>Выполняется…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// App (router)
// -----------------------------------------------------------------------------
export default function App(){
  const hash = useHashRoute();
  const { path, qs } = parseHash();

  let view: any = null;
  if(path?.startsWith('#/expert/')){
    const slug = decodeURIComponent(path.replace('#/expert/',''));
    view = <ExpertPage slug={slug}/>;
  } else if(path === '#/checkout'){
    view = <CheckoutPage bookingId={qs.get('booking')||''}/>;
  } else if(path === '#/success'){
    view = <SuccessPage bookingId={qs.get('booking')||''}/>;
  } else if(path === '#/experts'){
    view = <ExpertsPage/>;
  } else if(path === '#/apply'){
    view = <ApplyPage/>;
  } else if(path === '#/dash/expert'){
    view = <ExpertDashboard/>;
  } else if(path === '#/dash/client'){
    view = <ClientDashboard/>;
  } else if(path === '#/leads'){
    view = <LeadCapturePage/>;
  } else if(path === '#/logs'){
    view = <LogsPage/>;
  } else if(path === '#/qa'){
    view = <QAPage/>;
  } else {
    view = <LandingPage/>;
  }

  void hash; // чтобы триггерился ререндер на смене hash

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <NavBar/>
      {view}
      <footer className="mt-16 border-t">
        <div className="mx-auto max-w-7xl px-4 py-10 text-sm text-gray-600">© {new Date().getFullYear()} [Название] • TODO(UI): полировка дизайна, sticky‑CTA, анимации</div>
      </footer>
    </div>
  );
}
