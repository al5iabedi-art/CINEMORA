// CINEMORA 2.0 PRO — backend
// Keeps the TMDB token on the server only. The browser never sees it.
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TMDB_TOKEN = process.env.TMDB_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const TMDB = 'https://api.themoviedb.org/3';

if (!ADMIN_PASSWORD) console.warn('[CINEMORA] هشدار: ADMIN_PASSWORD تنظیم نشده. پنل ادمین غیرفعال است.');
if (!TMDB_TOKEN) console.warn('[CINEMORA] هشدار: TMDB_TOKEN تنظیم نشده. سایت به دیتابیس وصل نمی‌شود.');

// ---------- tiny json "database" (links, stats) ----------
// make sure the data directory exists even if git didn't track an empty folder
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}
const DEFAULT_TEXTS = {
  heroEyebrow: 'THE CLASSIC SCREEN ARCHIVE',
  heroTitlePlain: 'اسمش یادت نیست؟',
  heroTitleEm: 'پیداش کن.',
  heroLead: 'داستان، صحنه، شخصیت یا هر چیزی که از یک فیلم، سریال، انیمه یا انیمیشن یادت مانده را بنویس؛ به فارسی یا انگلیسی، بدون نیاز به اسم اثر. CINEMORA با چند لایه تحلیل، نزدیک‌ترین آثار را پیدا می‌کند و دلیل هر پیشنهاد را نشان می‌دهد.',
  footerName: 'علی عابدی',
  footerInstagram: 'aliabedih',
};
function loadDB() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    raw.comments = raw.comments || {};
    raw.likes = raw.likes || {};
    raw.ratings = raw.ratings || {};
    raw.lists = raw.lists || {};
    raw.texts = { ...DEFAULT_TEXTS, ...(raw.texts || {}) };
    return raw;
  }
  catch { return { links: {}, stats: { searches: 0, views: 0, queries: [], topViewed: {} }, comments: {}, likes: {}, ratings: {}, lists: {}, texts: { ...DEFAULT_TEXTS } }; }
}
function saveDB(db) {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) { console.error('[CINEMORA] db write failed:', e.message); }
}
let db = loadDB();
const key = (type, id) => `${type}:${id}`;

// ---------- in-memory sessions ----------
const sessions = new Map(); // token -> expiry
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12h
function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}
function requireAdmin(req, res, next) {
  const token = req.cookies?.cine_admin;
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'UNAUTHORIZED' });
  sessions.set(token, Date.now() + SESSION_TTL);
  next();
}

// ---------- simple TTL cache for TMDB calls ----------
const cache = new Map();
function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit || hit.expires < Date.now()) return null;
  return hit.data;
}
function cacheSet(k, data, ttlMs) { cache.set(k, { data, expires: Date.now() + ttlMs }); }

async function tmdb(pathname, params = {}) {
  if (!TMDB_TOKEN) throw new Error('NO_SERVER_KEY');
  const ck = pathname + JSON.stringify(params);
  const cached = cacheGet(ck);
  if (cached) return cached;
  const url = new URL(TMDB + pathname);
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== '' && url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + TMDB_TOKEN, accept: 'application/json' } });
  if (!r.ok) throw new Error('TMDB_' + r.status);
  const data = await r.json();
  cacheSet(ck, data, 10 * 60 * 1000); // 10 min
  return data;
}

// ---------- translate Persian queries to English (TMDB data is mostly English) ----------
const isPersian = (s) => /[\u0600-\u06FF]/.test(s);
const translateCache = new Map();
async function translateRaw(text, from, to) {
  // Primary: Google's public translate endpoint (no key, generous limits)
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + from + '&tl=' + to + '&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(url);
    if (r.ok) {
      const j = await r.json();
      const translated = (j?.[0] || []).map(seg => seg[0]).join('');
      if (translated && translated.trim().length > 0) return translated;
    }
  } catch {}
  // Fallback: MyMemory
  try {
    const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 490)) + '&langpair=' + from + '|' + to);
    const j = await r.json();
    const translated = j?.responseData?.translatedText;
    if (translated && translated.length > 1) return translated;
  } catch {}
  return null;
}
async function translateToEnglish(text) {
  if (!isPersian(text)) return text;
  if (translateCache.has('en:' + text)) return translateCache.get('en:' + text);
  const result = (await translateRaw(text, 'fa', 'en')) || text;
  translateCache.set('en:' + text, result);
  return result;
}
async function translateToPersian(text) {
  if (!text || isPersian(text)) return text;
  if (translateCache.has('fa:' + text)) return translateCache.get('fa:' + text);
  const result = (await translateRaw(text, 'en', 'fa')) || text;
  translateCache.set('fa:' + text, result);
  return result;
}

// ---------- Persian/English keyword extraction + genre map ----------
const STOP = new Set([
  'یک','یه','و','در','با','از','که','را','به','برای','این','آن','آنها','او','ها','های','هست','است','بود','شود','می','میشه','میشود','هم','تا','یا','روی','بین','بی',
  'the','a','an','of','and','in','with','is','are','was','to','for','on','at','it','this','that','who','about','into'
]);
const GENRE_MAP = [
  [/ترسناک|وحشت|هراس|horror/i, 27], [/عاشقانه|رمانتیک|عشق/i, 10749], [/علمی.?تخیلی|فضایی|فضا|sci.?fi/i, 878],
  [/کمدی|خنده|comedy/i, 35], [/کارآگاه|جنایی|پلیسی|قتل|crime/i, 80], [/جنگ|war/i, 10752],
  [/انیمیشن|کارتون|animat/i, 16], [/فانتزی|fantasy/i, 14], [/درام|drama/i, 18], [/اکشن|action/i, 28],
  [/ماجراجویی|adventure/i, 12], [/تاریخی|history/i, 36], [/موزیکال|musical/i, 10402], [/خانوادگی|family/i, 10751],
  [/معمایی|راز|mystery/i, 9648], [/مستند|documentary/i, 99], [/وسترن|western/i, 37],
];
function extractKeywords(q) {
  const words = q.replace(/[،,.!?؟«»"'()]/g, ' ').split(/\s+/).map(w => w.trim()).filter(w => w.length > 1 && !STOP.has(w.toLowerCase()));
  return [...new Set(words)].slice(0, 10);
}
function matchGenres(q) {
  const ids = new Set();
  GENRE_MAP.forEach(([re, id]) => { if (re.test(q)) ids.add(id); });
  return [...ids];
}

// ---------- multi-stage smart search ----------
async function smartSearch(qRaw) {
  const q = qRaw; // original, possibly Persian — used for genre matching
  const qEn = await translateToEnglish(qRaw); // English version — used for TMDB matching (its data is mostly English)
  const words = extractKeywords(qEn);
  const genreIds = matchGenres(q); // genre words matched against the original text (fa or en)
  const tasks = [];
  const LANG = 'en-US'; // search against English data for much better matching; details() re-fetches fa-IR for display
  const genrePage = String(1 + Math.floor(Math.random() * 3)); // vary results across repeated same-genre queries

  tasks.push(tmdb('/search/movie', { query: qEn, language: LANG, include_adult: false }).then(d => ({ src: 'title', results: d.results.map(x => ({ ...x, media_type: 'movie' })) })).catch(() => ({ src: 'title', results: [] })));
  tasks.push(tmdb('/search/tv', { query: qEn, language: LANG, include_adult: false }).then(d => ({ src: 'title', results: d.results.map(x => ({ ...x, media_type: 'tv' })) })).catch(() => ({ src: 'title', results: [] })));
  if (qEn !== q) {
    // also try the raw untranslated query in case it already contains an English/partial title
    tasks.push(tmdb('/search/movie', { query: q, language: LANG, include_adult: false }).then(d => ({ src: 'title', results: d.results.map(x => ({ ...x, media_type: 'movie' })) })).catch(() => ({ src: 'title', results: [] })));
    tasks.push(tmdb('/search/tv', { query: q, language: LANG, include_adult: false }).then(d => ({ src: 'title', results: d.results.map(x => ({ ...x, media_type: 'tv' })) })).catch(() => ({ src: 'title', results: [] })));
  }

  // theme keyword discovery: look up TMDB keyword ids for a few extracted (English) words
  const kwIds = [];
  for (const w of words.slice(0, 6)) {
    try {
      const d = await tmdb('/search/keyword', { query: w });
      const hit = (d.results || []).find(k => k.name.toLowerCase().includes(w.toLowerCase())) || d.results?.[0];
      if (hit) kwIds.push(hit.id);
    } catch {}
  }
  if (kwIds.length) {
    tasks.push(tmdb('/discover/movie', { with_keywords: kwIds.join('|'), language: LANG, sort_by: 'popularity.desc' }).then(d => ({ src: 'keyword', results: d.results.map(x => ({ ...x, media_type: 'movie' })) })).catch(() => ({ src: 'keyword', results: [] })));
    tasks.push(tmdb('/discover/tv', { with_keywords: kwIds.join('|'), language: LANG, sort_by: 'popularity.desc' }).then(d => ({ src: 'keyword', results: d.results.map(x => ({ ...x, media_type: 'tv' })) })).catch(() => ({ src: 'keyword', results: [] })));
  }
  if (genreIds.length) {
    tasks.push(tmdb('/discover/movie', { with_genres: genreIds.join(','), language: LANG, sort_by: 'popularity.desc', page: genrePage }).then(d => ({ src: 'genre', results: d.results.map(x => ({ ...x, media_type: 'movie' })) })).catch(() => ({ src: 'genre', results: [] })));
    tasks.push(tmdb('/discover/tv', { with_genres: genreIds.join(','), language: LANG, sort_by: 'popularity.desc', page: genrePage }).then(d => ({ src: 'genre', results: d.results.map(x => ({ ...x, media_type: 'tv' })) })).catch(() => ({ src: 'genre', results: [] })));
  }

  const batches = await Promise.all(tasks);

  // name-based lookup: if the query matches a real person (director/actor) or a studio/company, pull their works directly
  const nameBatches = [];
  try {
    const [personRes, companyRes] = await Promise.all([
      tmdb('/search/person', { query: qEn }).catch(() => ({ results: [] })),
      tmdb('/search/company', { query: qEn }).catch(() => ({ results: [] })),
    ]);
    const person = (personRes.results || [])[0];
    if (person && person.popularity > 0.5) {
      const credits = await tmdb(`/person/${person.id}/combined_credits`, { language: LANG }).catch(() => null);
      if (credits) {
        const isDirector = person.known_for_department === 'Directing';
        const works = isDirector
          ? (credits.crew || []).filter(c => c.job === 'Director')
          : (credits.cast || []);
        nameBatches.push({ src: 'person', results: works.slice(0, 20).map(x => ({ ...x, media_type: x.media_type })), personName: person.name });
      }
    }
    const company = (companyRes.results || [])[0];
    if (company) {
      const [cm, ct] = await Promise.all([
        tmdb('/discover/movie', { with_companies: company.id, language: LANG, sort_by: 'popularity.desc' }).catch(() => ({ results: [] })),
        tmdb('/discover/tv', { with_companies: company.id, language: LANG, sort_by: 'popularity.desc' }).catch(() => ({ results: [] })),
      ]);
      nameBatches.push({ src: 'company', results: [...cm.results.map(x => ({ ...x, media_type: 'movie' })), ...ct.results.map(x => ({ ...x, media_type: 'tv' }))], companyName: company.name });
    }
  } catch {}

  const pool = new Map();
  for (const b of [...batches, ...nameBatches]) {
    for (const item of b.results) {
      const k = item.media_type + ':' + item.id;
      if (!pool.has(k)) pool.set(k, { item, sources: new Set() });
      pool.get(k).sources.add(b.src);
    }
  }

  const personName = nameBatches.find(b => b.src === 'person')?.personName;
  const companyName = nameBatches.find(b => b.src === 'company')?.companyName;
  const wl = words.map(w => w.toLowerCase());
  const scored = [...pool.values()].map(({ item, sources }) => {
    const titleText = (item.title || item.name || '').toLowerCase();
    const overviewHits = wl.filter(w => (item.overview || '').toLowerCase().includes(w));
    const titleHits = wl.filter(w => titleText.includes(w));
    const textScore = wl.length ? (overviewHits.length + titleHits.length * 1.5) / wl.length : 0;
    const sourceScore = (sources.has('keyword') ? 0.9 : 0) + (sources.has('genre') ? 0.4 : 0) + (sources.has('title') ? 0.6 : 0) + (sources.has('person') ? 1.3 : 0) + (sources.has('company') ? 1.1 : 0);
    const pop = Math.min((item.popularity || 0) / 300, 0.3);
    const score = textScore + sourceScore + pop;
    const match = Math.max(5, Math.min(100, Math.round((score / 2.2) * 100)));
    const clues = [];
    if (sources.has('person') && personName) clues.push(`از آثار ${personName}`);
    if (sources.has('company') && companyName) clues.push(`محصول استودیوی ${companyName}`);
    if (titleHits.length) clues.push(`عنوان شامل «${titleHits[0]}»`);
    if (overviewHits.length) clues.push(`خلاصه داستان با «${overviewHits.slice(0, 2).join('، ')}» تطابق دارد`);
    if (sources.has('keyword')) clues.push('از نظر موضوعی با کلیدواژه‌های داستان شما همسو است');
    if (sources.has('genre')) clues.push('ژانر با توضیح شما همخوانی دارد');
    if (!clues.length) clues.push('بر اساس محبوبیت و شباهت کلی پیشنهاد شده');
    return { item, score, match, clues };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// health / config (no secrets)
app.get('/api/status', (req, res) => res.json({ connected: !!TMDB_TOKEN }));

app.get('/api/discover', async (req, res) => {
  try {
    const { type = 'all', sort = 'popularity.desc', min = '0', page = '1', decade = '0' } = req.query;
    const p = { language: 'fa-IR', page, sort_by: sort, 'vote_average.gte': min, include_adult: false };
    const dec = Number(decade);
    if (dec) {
      p['primary_release_date.gte'] = dec + '-01-01';
      p['primary_release_date.lte'] = (dec + 9) + '-12-31';
      p['first_air_date.gte'] = dec + '-01-01';
      p['first_air_date.lte'] = (dec + 9) + '-12-31';
    }
    async function one(t, extra = {}) {
      const params = { ...p, ...extra };
      // movie uses primary_release_date.*, tv uses first_air_date.* — strip the irrelevant pair per type
      if (t === 'movie') { delete params['first_air_date.gte']; delete params['first_air_date.lte']; }
      if (t === 'tv') { delete params['primary_release_date.gte']; delete params['primary_release_date.lte']; }
      return tmdb('/discover/' + t, params);
    }
    let results = [], totalPages = 1;
    if (type === 'all') {
      const [m, t] = await Promise.all([one('movie'), one('tv')]);
      results = [...m.results.map(x => ({ ...x, media_type: 'movie' })), ...t.results.map(x => ({ ...x, media_type: 'tv' }))];
      totalPages = Math.max(m.total_pages, t.total_pages);
    } else if (type === 'movie' || type === 'tv') {
      const d = await one(type);
      results = d.results.map(x => ({ ...x, media_type: type }));
      totalPages = d.total_pages;
    } else if (type === 'anime') {
      const [m, t] = await Promise.all([one('movie', { with_genres: 16, with_origin_country: 'JP' }), one('tv', { with_genres: 16, with_origin_country: 'JP' })]);
      results = [...m.results.map(x => ({ ...x, media_type: 'movie' })), ...t.results.map(x => ({ ...x, media_type: 'tv' }))];
      totalPages = Math.max(m.total_pages, t.total_pages);
    } else if (type === 'animation') {
      const [m, t] = await Promise.all([one('movie', { with_genres: 16, without_origin_country: 'JP' }), one('tv', { with_genres: 16, without_origin_country: 'JP' })]);
      results = [...m.results.map(x => ({ ...x, media_type: 'movie' })), ...t.results.map(x => ({ ...x, media_type: 'tv' }))];
      totalPages = Math.max(m.total_pages, t.total_pages);
    }
    res.json({ results, total_pages: Math.min(totalPages || 1, 500) });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1'));
    if (!q) return res.status(400).json({ error: 'EMPTY_QUERY' });
    db.stats.searches++; db.stats.queries.unshift({ q, ts: Date.now() }); db.stats.queries = db.stats.queries.slice(0, 200); saveDB(db);
    const ranked = await smartSearch(q);
    const pageSize = 20;
    const slice = ranked.slice((page - 1) * pageSize, page * pageSize);
    res.json({
      results: slice.map(r => ({ ...r.item, _clues: r.clues, _match: r.match })),
      total_pages: Math.max(1, Math.ceil(ranked.length / pageSize)),
      total_results: ranked.length,
    });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/discovery', async (req, res) => {
  try {
    const d = await tmdb('/trending/all/week', { language: 'fa-IR' });
    const shuffled = [...(d.results || [])].sort(() => Math.random() - 0.5).slice(0, 12);
    res.json({ results: shuffled });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/details', async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!['movie', 'tv'].includes(type) || !id) return res.status(400).json({ error: 'BAD_PARAMS' });
    const d = await tmdb(`/${type}/${id}`, { language: 'fa-IR', append_to_response: 'credits,videos,external_ids,watch/providers,images', include_image_language: 'en,fa,null' });
    const similar = await tmdb(`/${type}/${id}/similar`, { language: 'fa-IR' }).catch(() => ({ results: [] }));
    const customLinks = db.links[key(type, id)] || [];
    const comments = db.comments[key(type, id)] || [];
    const likes = db.likes[key(type, id)] || 0;
    const ratingData = db.ratings[key(type, id)] || { sum: 0, count: 0 };
    const userRating = ratingData.count ? Math.round((ratingData.sum / ratingData.count) * 10) / 10 : null;
    db.stats.views++;
    const vk = key(type, id);
    db.stats.topViewed[vk] = (db.stats.topViewed[vk] || { title: d.title || d.name, count: 0 });
    db.stats.topViewed[vk].count++;
    saveDB(db);
    const titleForSearch = d.title || d.name || '';
    const iranLinks = titleForSearch ? [
      { label: 'جستجو در فیلیمو', url: 'https://www.filimo.com/search?query=' + encodeURIComponent(titleForSearch), isSearch: true },
      { label: 'جستجو در نماوا', url: 'https://www.namava.ir/search?q=' + encodeURIComponent(titleForSearch), isSearch: true },
    ] : [];
    res.json({ ...d, _similar: (similar.results || []).slice(0, 12).map(x => ({ ...x, media_type: type })), _customLinks: customLinks, _iranLinks: iranLinks, _comments: comments, _likes: likes, _userRating: userRating, _ratingCount: ratingData.count });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/person', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'BAD_PARAMS' });
    const p = await tmdb(`/person/${id}`, { language: 'fa-IR', append_to_response: 'combined_credits,external_ids' });
    let bio = p.biography || '';
    if (!bio) {
      bio = await tmdb(`/person/${id}`, { language: 'en-US' }).then(x => x.biography).catch(() => '');
    }
    if (bio) bio = await translateToPersian(bio);
    const credits = (p.combined_credits?.cast || [])
      .filter(c => c.poster_path)
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .slice(0, 24)
      .map(c => ({ id: c.id, media_type: c.media_type, title: c.title || c.name, poster_path: c.poster_path, date: (c.release_date || c.first_air_date || '').slice(0, 4) }));
    res.json({ ...p, biography: bio, _credits: credits });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ---------- community star ratings ----------
app.post('/api/rate', (req, res) => {
  const { type, id, stars } = req.body || {};
  const s = Number(stars);
  if (!['movie', 'tv'].includes(type) || !id || !(s >= 1 && s <= 5)) return res.status(400).json({ error: 'BAD_PARAMS' });
  const k = key(type, id);
  db.ratings[k] = db.ratings[k] || { sum: 0, count: 0 };
  db.ratings[k].sum += s;
  db.ratings[k].count += 1;
  saveDB(db);
  const avg = Math.round((db.ratings[k].sum / db.ratings[k].count) * 10) / 10;
  res.json({ ok: true, average: avg, count: db.ratings[k].count });
});

// ---------- surprise me: one random high-quality pick ----------
app.get('/api/random', async (req, res) => {
  try {
    const type = Math.random() > 0.5 ? 'movie' : 'tv';
    const page = 1 + Math.floor(Math.random() * 20);
    const d = await tmdb('/discover/' + type, { language: 'fa-IR', sort_by: 'popularity.desc', 'vote_average.gte': 7, 'vote_count.gte': 200, page });
    const list = d.results || [];
    if (!list.length) return res.status(503).json({ error: 'NO_RESULTS' });
    const pick = list[Math.floor(Math.random() * list.length)];
    res.json({ ...pick, media_type: type });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ---------- next-episode tracker ----------
app.get('/api/next-episode', async (req, res) => {
  try {
    const { id, season, episode } = req.query;
    if (!id || !season || !episode) return res.status(400).json({ error: 'BAD_PARAMS' });
    const s = Number(season), e = Number(episode);
    const seasonData = await tmdb(`/tv/${id}/season/${s}`, { language: 'fa-IR' });
    const episodeCount = (seasonData.episodes || []).length;
    if (e < episodeCount) {
      const next = seasonData.episodes[e]; // zero-indexed, so index e = episode e+1
      return res.json({ season: s, episode: e + 1, name: next?.name || '', overview: next?.overview || '' });
    }
    // try next season
    const nextSeasonData = await tmdb(`/tv/${id}/season/${s + 1}`, { language: 'fa-IR' }).catch(() => null);
    if (nextSeasonData && (nextSeasonData.episodes || []).length) {
      const next = nextSeasonData.episodes[0];
      return res.json({ season: s + 1, episode: 1, name: next?.name || '', overview: next?.overview || '' });
    }
    res.json({ season: null, episode: null, finished: true });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ---------- shareable personal lists ----------
app.post('/api/lists', (req, res) => {
  const { name } = req.body || {};
  const id = crypto.randomBytes(6).toString('hex');
  db.lists[id] = { name: (name || 'لیست من').toString().slice(0, 80), items: [], createdAt: Date.now() };
  saveDB(db);
  res.json({ ok: true, id, list: db.lists[id] });
});
app.get('/api/lists/:id', (req, res) => {
  const list = db.lists[req.params.id];
  if (!list) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ id: req.params.id, ...list });
});
app.post('/api/lists/:id/items', (req, res) => {
  const list = db.lists[req.params.id];
  if (!list) return res.status(404).json({ error: 'NOT_FOUND' });
  const { type, id, title, poster_path } = req.body || {};
  if (!['movie', 'tv'].includes(type) || !id) return res.status(400).json({ error: 'BAD_PARAMS' });
  if (!list.items.some(x => x.type === type && x.id === id)) {
    list.items.push({ type, id, title: title || '', poster_path: poster_path || '', addedAt: Date.now() });
    saveDB(db);
  }
  res.json({ ok: true, list });
});
app.delete('/api/lists/:id/items', (req, res) => {
  const list = db.lists[req.params.id];
  if (!list) return res.status(404).json({ error: 'NOT_FOUND' });
  const { type, id } = req.body || {};
  list.items = list.items.filter(x => !(x.type === type && x.id === id));
  saveDB(db);
  res.json({ ok: true, list });
});

// ---------- likes & comments (public, no admin needed) ----------
app.post('/api/like', (req, res) => {
  const { type, id } = req.body || {};
  if (!['movie', 'tv'].includes(type) || !id) return res.status(400).json({ error: 'BAD_PARAMS' });
  const k = key(type, id);
  db.likes[k] = (db.likes[k] || 0) + 1;
  saveDB(db);
  res.json({ ok: true, likes: db.likes[k] });
});

app.post('/api/comments', (req, res) => {
  const { type, id, name, text } = req.body || {};
  if (!['movie', 'tv'].includes(type) || !id) return res.status(400).json({ error: 'BAD_PARAMS' });
  const cleanText = (text || '').toString().trim().slice(0, 500);
  const cleanName = (name || 'کاربر مهمان').toString().trim().slice(0, 40) || 'کاربر مهمان';
  if (!cleanText) return res.status(400).json({ error: 'EMPTY_COMMENT' });
  const k = key(type, id);
  db.comments[k] = db.comments[k] || [];
  const comment = { name: cleanName, text: cleanText, ts: Date.now() };
  db.comments[k].unshift(comment);
  db.comments[k] = db.comments[k].slice(0, 300);
  saveDB(db);
  res.json({ ok: true, comment, count: db.comments[k].length });
});

// ---------- editable site texts ----------
app.get('/api/texts', (req, res) => res.json(db.texts));
app.get('/api/admin/texts', requireAdmin, (req, res) => res.json(db.texts));
app.post('/api/admin/texts', requireAdmin, (req, res) => {
  const body = req.body || {};
  Object.keys(DEFAULT_TEXTS).forEach(k => {
    if (typeof body[k] === 'string') db.texts[k] = body[k].slice(0, 2000);
  });
  saveDB(db);
  res.json({ ok: true, texts: db.texts });
});

// ---------- admin ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'BAD_PASSWORD' });
  const token = newSession();
  res.cookie('cine_admin', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL });
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  sessions.delete(req.cookies?.cine_admin);
  res.clearCookie('cine_admin');
  res.json({ ok: true });
});
app.get('/api/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/links', requireAdmin, (req, res) => res.json({ links: db.links }));
app.post('/api/admin/links', requireAdmin, (req, res) => {
  const { type, id, label, url, title } = req.body || {};
  if (!['movie', 'tv'].includes(type) || !id || !label || !url) return res.status(400).json({ error: 'BAD_PARAMS' });
  const k = key(type, id);
  db.links[k] = db.links[k] || [];
  db.links[k].push({ label, url, title: title || '', addedAt: Date.now() });
  saveDB(db);
  res.json({ ok: true, links: db.links[k] });
});
app.delete('/api/admin/links', requireAdmin, (req, res) => {
  const { type, id, index } = req.body || {};
  const k = key(type, id);
  if (db.links[k]) db.links[k].splice(index, 1);
  saveDB(db);
  res.json({ ok: true, links: db.links[k] || [] });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const top = Object.values(db.stats.topViewed).sort((a, b) => b.count - a.count).slice(0, 10);
  res.json({ searches: db.stats.searches, views: db.stats.views, recentQueries: db.stats.queries.slice(0, 30), topViewed: top, connected: !!TMDB_TOKEN });
});

app.listen(PORT, () => console.log(`CINEMORA server on http://localhost:${PORT}`));
