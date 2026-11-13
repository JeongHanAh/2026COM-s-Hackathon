import { isIP } from 'node:net';

// Open-Meteo's free endpoint is for non-commercial use. Display Open-Meteo /
// GeoNames attribution in the search UI. Google News RSS is used only in the
// authenticated personal, non-commercial reader; do not republish or export it.
// Neither provider supplies verified damage observations. GDELT's observed
// timestamp is not a publisher-confirmed publication timestamp.
export const PLACE_ATTRIBUTION = Object.freeze({
  provider: 'Open-Meteo', url: 'https://open-meteo.com/en/docs/geocoding-api',
  data: 'GeoNames', dataUrl: 'https://www.geonames.org/',
});
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const NEWS_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const RSS_URL = 'https://news.google.com/rss/search';
const USER_AGENT = 'Still/1.0 (+https://github.com/JeongHanAh/2026COM-s-Hackathon)';
// Open-Meteo does not consistently index Korean aliases (including 서울).
// These exact search aliases only choose query text; places and coordinates
// always come from the provider, and all other input is passed through unchanged.
const SEARCH_ALIASES = new Map([
  [['서울', '서울시', '서울특별시'], 'Seoul'],
  [['부산', '부산시', '부산광역시'], 'Busan'],
  [['인천', '인천시', '인천광역시'], 'Incheon'],
  [['대구', '대구시', '대구광역시'], 'Daegu'],
  [['대전', '대전시', '대전광역시'], 'Daejeon'],
  [['광주', '광주시', '광주광역시'], 'Gwangju'],
  [['울산', '울산시', '울산광역시'], 'Ulsan'],
  [['세종', '세종시', '세종특별자치시'], 'Sejong'],
  [['키이우'], 'Kyiv'],
  [['가자', '가자시'], 'Gaza'],
].flatMap(([names, query]) => names.map(name => [name, query])));
const HOUR = 3600000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const queues = new WeakMap();
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const invalidLocation = () => fail(400, 'INVALID_LOCATION', '검색 결과에서 도시나 지역을 선택해 주세요.');
const unavailable = kind => fail(503, kind === 'news' ? 'NEWS_UNAVAILABLE' : 'PLACE_SEARCH_UNAVAILABLE',
  kind === 'news' ? '지역 기사를 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' : '지역 검색에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');

function text(value, maximum = 200) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f<>]/u.test(value)) throw invalidLocation();
  const result = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!result || result.length > maximum) throw invalidLocation();
  return result;
}

function placeId(value) {
  if (typeof value !== 'string' || !/^geonames:[1-9]\d{0,10}$/.test(value)) throw invalidLocation();
  return value;
}

// A shape check is not evidence that a client-provided point is a locality.
// resolveLocation() below obtains canonical fields before persistence or news I/O.
export function validateLocation(location) {
  if (!location || typeof location !== 'object' || Array.isArray(location)) throw invalidLocation();
  const { lat, lon } = location;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)
    || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw invalidLocation();
  return {
    id: placeId(location.id), label: text(location.label), region: text(location.region, 160),
    lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, newsQuery: text(location.newsQuery),
  };
}

function publicHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host.includes('.') && !isIP(host) && !host.startsWith('[')
    && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host);
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('지역 정보 제공자의 HTTPS 주소를 확인해 주세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
    || !publicHostname(url.hostname)) throw new Error('지역 정보 제공자의 HTTPS 주소를 확인해 주세요.');
  return url;
}

function searchTerm(value) {
  const query = text(value);
  // No coordinates, postal codes, house numbers, URLs, or email addresses.
  // Search is submitted explicitly by the user, never on each keystroke.
  if (query.length < 2 || !/^[\p{L}\p{M}][\p{L}\p{M}\s.,'’()-]*$/u.test(query)) {
    throw fail(400, 'REGION_NAME_REQUIRED', '상세 주소 대신 도시나 지역 이름을 입력해 주세요.');
  }
  return query;
}

function canonicalPlace(row) {
  if (!row || !/^(PPL(?:A[1-5]?|C|G|H|L|Q|R|S|W|X)?|ADM[1-4])$/.test(row.feature_code || '')
    || !Number.isSafeInteger(row.id) || row.id <= 0) return null;
  try {
    const name = text(row.name), country = text(row.country);
    const admin = row.admin1 ? text(row.admin1) : null;
    const unique = values => [...new Set(values.filter(Boolean))];
    return validateLocation({ id: `geonames:${row.id}`, label: unique([name, admin, country]).join(', '),
      region: name, lat: row.latitude, lon: row.longitude, newsQuery: unique([name, country]).join(', ') });
  } catch { return null; }
}

function cacheStore(maximum, now) {
  const entries = new Map();
  return {
    get(key, age) {
      const entry = entries.get(key);
      if (!entry || now() - entry.time >= age) return null;
      entries.delete(key); entries.set(key, entry);
      return structuredClone(entry.value);
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { time: now(), value: structuredClone(value) });
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
    },
  };
}

// Shared by service instances using the same transport (the default global fetch).
// Only one request per provider is in flight, including reading its response body.
function providerQueue(fetchImpl, host, interval, now, sleep, dailyLimit = Infinity) {
  let providers = queues.get(fetchImpl);
  if (!providers) { providers = new Map(); queues.set(fetchImpl, providers); }
  let state = providers.get(host);
  if (!state) { state = { tail: Promise.resolve(), pending: 0, nextAt: 0, dayStart: now(), count: 0 }; providers.set(host, state); }
  return async task => {
    if (state.pending >= 2 || state.nextAt - now() > 15000) {
      throw fail(429, 'PLACE_NEWS_BUSY', '지역 정보를 불러오는 중이에요. 잠시 뒤 다시 시도해 주세요.');
    }
    state.pending++;
    const queuedAt = now();
    const result = state.tail.then(async () => {
      const wait = Math.max(0, state.nextAt - now());
      if (now() - queuedAt + wait > 15000) throw fail(429, 'PLACE_NEWS_BUSY', '지역 정보를 불러오는 중이에요. 잠시 뒤 다시 시도해 주세요.');
      if (wait) await sleep(wait);
      if (now() - state.dayStart >= 24 * HOUR) { state.dayStart = now(); state.count = 0; }
      if (state.count >= dailyLimit) throw fail(429, 'PLACE_SEARCH_LIMIT', '오늘 지역 검색 요청이 많습니다. 나중에 다시 시도해 주세요.');
      state.count++;
      try { return await task(); }
      finally { state.nextAt = Math.max(state.nextAt, now() + interval); }
    }).finally(() => { state.pending--; });
    state.tail = result.catch(() => {});
    return result;
  };
}

async function providerResponse(fetchImpl, url, kind, timeoutMs, format = 'json') {
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error',
      headers: { Accept: format === 'rss' ? 'application/rss+xml, application/xml, text/xml' : 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw unavailable(kind); }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel(); throw unavailable(kind);
    }
    const chunks = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw unavailable(kind);
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return format === 'rss' ? body : JSON.parse(body);
  } catch { throw unavailable(kind); }
}

function articleUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !publicHostname(url.hostname)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|ref_src|ref_url)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url;
  } catch { return null; }
}

function observedDate(value) {
  if (typeof value !== 'string') return null;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso)) return null;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().replace('.000Z', 'Z') === iso ? parsed.toISOString() : null;
}

function articlesFrom(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error
    || (!Array.isArray(data.articles) && Object.keys(data).length)) throw unavailable('news');
  const articles = [], seen = new Set();
  for (const row of (data.articles || []).slice(0, 100)) {
    const url = articleUrl(row?.url);
    let title;
    try { title = text(row?.title, 500); } catch { continue; }
    const identity = url && `${url.host}${url.pathname}${url.search}`;
    if (!url || seen.has(identity)) continue;
    seen.add(identity);
    articles.push({ title, url: url.href, source: url.hostname.replace(/^www\./, ''),
      publishedAt: null, observedAt: observedDate(row.seendate) });
    if (articles.length === 12) break;
  }
  return articles;
}

function xmlText(value) {
  if (typeof value !== 'string' || value.length > 8192) throw unavailable('news');
  // This limited RSS reader has no DTD, external entity, DOM, or HTML execution.
  // Only predefined XML entities, numeric references, and literal CDATA are read.
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&([^;\s]{1,20});/g, (whole, cdata, entity) => {
    if (cdata !== undefined) return cdata;
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    const decimal = /^#\d{1,7}$/.test(entity), hex = /^#x[\da-f]{1,6}$/i.test(entity);
    if (!decimal && !hex) throw unavailable('news');
    const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw unavailable('news');
    return String.fromCodePoint(code);
  }).trim();
}

function feedDate(value) {
  if (typeof value !== 'string' || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toUTCString() === value ? date.toISOString() : null;
}

function articlesFromRss(xml) {
  if (typeof xml !== 'string' || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)
    || !/<rss(?:\s[^>]*)?>/i.test(xml) || !/<channel(?:\s[^>]*)?>/i.test(xml)
    || !/<\/channel\s*>\s*<\/rss\s*>\s*$/i.test(xml)) throw unavailable('news');
  const fields = ['title', 'link', 'source', 'pubDate'];
  const rows = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)];
  const articles = [], seen = new Set();
  for (const match of rows.slice(0, 100)) {
    const row = {};
    try {
      for (const field of fields) {
        const content = new RegExp(`<${field}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${field}\\s*>`, 'i').exec(match[1]);
        row[field] = content ? xmlText(content[1]) : '';
      }
      const url = articleUrl(row.link);
      if (!url || url.hostname !== 'news.google.com' || !/^\/(rss\/)?articles\/[\w-]+\/?$/.test(url.pathname) || seen.has(url.href)) continue;
      const title = text(row.title, 500), source = text(row.source, 200);
      seen.add(url.href);
      articles.push({ title, url: url.href, source, publishedAt: feedDate(row.pubDate), observedAt: null,
        dateSource: 'Google News 피드 게시 시각' });
    } catch { /* Invalid items cannot become links or executable markup. */ }
  }
  // A broken HTML/error page, truncated item, or malformed feed is not an empty result.
  if ((/<item\b/i.test(xml) && !rows.length) || (rows.length && !articles.length)) throw unavailable('news');
  // RSS may be ordered by relevance. ISO dates sort chronologically; stable sort
  // keeps feed order for equal dates and puts unknown dates after dated entries.
  return articles.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '')).slice(0, 12);
}

export function createPlaceNewsService({ fetchImpl = fetch, now = Date.now, sleep = pause,
  geocodingUrl = process.env.STILL_GEOCODING_URL || GEO_URL,
  newsProvider = process.env.STILL_NEWS_PROVIDER || 'google-rss',
  newsUrl = process.env.STILL_NEWS_URL, timeoutMs = 12000,
  cacheEntries = 256, placeCacheMs = 24 * HOUR, newsCacheMs = 15 * 60000, staleNewsMs = 24 * HOUR } = {}) {
  if (!['google-rss', 'gdelt'].includes(newsProvider)) throw new Error('지원하는 지역 뉴스 제공자를 선택해 주세요.');
  const geo = endpoint(geocodingUrl), news = endpoint(newsUrl || (newsProvider === 'google-rss' ? RSS_URL : NEWS_URL));
  if (newsProvider === 'google-rss' && news.href !== RSS_URL) throw new Error('Google News 피드에는 공식 검색 주소를 사용해 주세요.');
  const lookup = new URL(geo); lookup.pathname = lookup.pathname.replace(/\/search\/?$/, '/get');
  if (lookup.pathname === geo.pathname) throw new Error('지역 검색 주소는 /search로 끝나야 합니다.');
  const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 12000, 15000));
  const maximum = Math.max(1, Math.min(Number(cacheEntries) || 256, 512));
  const placeAge = Math.max(60000, Math.min(Number(placeCacheMs) || 24 * HOUR, 7 * 24 * HOUR));
  const newsAge = Math.max(60000, Math.min(Number(newsCacheMs) || 15 * 60000, HOUR));
  const staleAge = Math.max(newsAge, Math.min(Number(staleNewsMs) || 24 * HOUR, 24 * HOUR));
  const searches = cacheStore(maximum, now), places = cacheStore(maximum, now), newsCache = cacheStore(maximum, now);
  const inFlight = new Map();
  const queueGeo = providerQueue(fetchImpl, geo.host, 1000, now, sleep, 9000);
  const queueNews = providerQueue(fetchImpl, news.host, newsProvider === 'gdelt' ? 5100 : 1000, now, sleep);

  async function single(key, task) {
    if (inFlight.has(key)) return structuredClone(await inFlight.get(key));
    if (inFlight.size >= 16) throw fail(429, 'PLACE_NEWS_BUSY', '지역 정보를 불러오는 중이에요. 잠시 뒤 다시 시도해 주세요.');
    const work = task(); inFlight.set(key, work);
    try { return structuredClone(await work); }
    finally { inFlight.delete(key); }
  }

  async function searchPlaces(value) {
    const submitted = searchTerm(value);
    const query = SEARCH_ALIASES.get(submitted) || submitted, key = query.toLocaleLowerCase('en');
    const cached = searches.get(key, placeAge);
    if (cached) return cached;
    return single('search:' + key, async () => {
      const url = new URL(geo);
      url.search = new URLSearchParams({ name: query, count: '10', language: 'en', format: 'json' }).toString();
      const data = await queueGeo(() => providerResponse(fetchImpl, url, 'place', timeout));
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error
        || (data.results !== undefined && !Array.isArray(data.results))
        || (data.results === undefined && Object.keys(data).some(key => key !== 'generationtime_ms'))) throw unavailable('place');
      const found = [], seen = new Set();
      for (const row of (data.results || []).slice(0, 40)) {
        const place = canonicalPlace(row);
        if (!place || seen.has(place.id)) continue;
        seen.add(place.id); found.push(place); places.set(place.id, place);
      }
      searches.set(key, found);
      return found;
    });
  }

  async function resolveLocation(location) {
    const id = placeId(location?.id);
    const cached = places.get(id, placeAge);
    if (cached) return cached;
    return single('place:' + id, async () => {
      const url = new URL(lookup);
      url.search = new URLSearchParams({ id: id.slice('geonames:'.length), language: 'en', format: 'json' }).toString();
      const data = await queueGeo(() => providerResponse(fetchImpl, url, 'place', timeout));
      const row = data?.results?.find(item => `geonames:${item?.id}` === id) || data;
      const place = canonicalPlace(row);
      if (!place || place.id !== id) throw invalidLocation();
      places.set(id, place);
      return place;
    });
  }

  async function getNews(location) {
    const id = placeId(location?.id);
    const cached = newsCache.get(id, newsAge);
    if (cached) return cached;
    return single('news:' + id, async () => {
      try {
        const canonical = await resolveLocation(location);
        // Only canonical provider names become terms. No client-controlled GDELT operators.
        const terms = canonical.newsQuery.split(', ').map(part => part.replace(/[^\p{L}\p{M}\p{N}\s'-]/gu, ' ').replace(/^[-\s]+|[-\s]+$/g, '').replace(/\s+/g, ' '));
        if (terms.some(term => !term || /^(OR|AND|NOT)$/i.test(term))) throw invalidLocation();
        // GDELT rejects quoted short single words such as "Gaza".
        const query = terms.map(term => term.includes(' ') ? `"${term}"` : term).join(' ');
        const url = new URL(news);
        url.search = new URLSearchParams(newsProvider === 'google-rss'
          ? { q: `${query} when:7d`, hl: 'ko', gl: 'KR', ceid: 'KR:ko' }
          : { query, mode: 'ArtList', format: 'json', maxrecords: '25', timespan: '7d', sort: 'DateDesc' }).toString();
        const data = await queueNews(() => providerResponse(fetchImpl, url, 'news', timeout, newsProvider === 'google-rss' ? 'rss' : 'json'));
        const result = { articles: newsProvider === 'google-rss' ? articlesFromRss(data) : articlesFrom(data),
          fetchedAt: new Date(now()).toISOString(), stale: false, query: canonical.newsQuery, coverage: '지역명 관련 기사',
          ...(newsProvider === 'google-rss' ? { provider: 'Google News', sourceUrl: 'https://news.google.com/', dateSource: 'Google News 피드 게시 시각' }
            : { provider: 'GDELT', sourceUrl: 'https://www.gdeltproject.org/', observedAtLabel: '기사 수집 시각' }) };
        newsCache.set(id, result);
        return result;
      } catch (error) {
        const previous = newsCache.get(id, staleAge);
        if (previous) return { ...previous, stale: true, warning: '새 기사를 불러오지 못해 이전 결과를 보여드려요.' };
        throw error;
      }
    });
  }

  return { searchPlaces, resolveLocation, getNews };
}
