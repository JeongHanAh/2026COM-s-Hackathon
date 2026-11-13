import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceNewsService, validateLocation } from './place-news.mjs';

// Provider responses are simulated. These tests do not send queries or user data
// to Open-Meteo, GDELT, or article publishers.
const seoul = { id: 1835848, name: 'Seoul', admin1: 'Seoul', country: 'South Korea',
  feature_code: 'PPLC', latitude: 37.566001, longitude: 126.978401 };
const busan = { id: 1838524, name: 'Busan', admin1: 'Busan', country: 'South Korea',
  feature_code: 'PPLA', latitude: 35.10168, longitude: 129.03004 };
const location = { id: 'geonames:1835848', label: 'Seoul, South Korea', region: 'Seoul',
  lat: 37.57, lon: 126.98, newsQuery: 'Seoul, South Korea' };
const article = { title: 'Seoul community news', url: 'https://news.example.org/story',
  domain: 'news.example.org', seendate: '20261114T010203Z' };

function fixture({ geo, news, newsProvider = 'gdelt' } = {}) {
  let time = Date.parse('2026-11-14T02:00:00Z');
  const calls = [];
  const state = { geo, news, newsFailure: false };
  const now = () => time;
  const sleep = async delay => { time += delay; };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options, at: time });
    time += 10;
    if (['api.gdeltproject.org', 'news.google.com'].includes(url.hostname)) {
      if (state.newsFailure) return new Response('Service unavailable', { status: 503 });
      return state.news ? state.news(url, options) : Response.json({ articles: [article] });
    }
    if (state.geo) return state.geo(url, options);
    if (url.pathname.endsWith('/get')) return Response.json(url.searchParams.get('id') === String(busan.id) ? busan : seoul);
    return Response.json({ results: [seoul] });
  };
  const options = { fetchImpl, now, sleep, newsProvider };
  return { options, calls, state, service: createPlaceNewsService(options), advance: value => { time += value; } };
}

test('location validation keeps only bounded coarse fields and rejects bad coordinates or identities', () => {
  assert.deepEqual(validateLocation({ ...location, label: '  Seoul,  South Korea ', lat: 37.566001, lon: 126.978401,
    address: 'private address', secret: 'must not survive' }), location);
  for (const value of [null, [], { ...location, id: 'https://other.example.org' },
    { ...location, lat: NaN }, { ...location, lat: 91 }, { ...location, lon: -181 },
    { ...location, lat: '37.57' }, { ...location, newsQuery: 'x'.repeat(201) },
    { ...location, label: 'a\nb' }, { ...location, region: '<script>' }]) {
    assert.throws(() => validateLocation(value), error => error.status === 400 && error.code === 'INVALID_LOCATION');
  }
});

test('submitted search returns only localities and excludes addresses, buildings, and unknown result fields', async () => {
  const f = fixture({ geo: () => Response.json({ results: [seoul, { ...seoul },
    { ...seoul, id: 15, feature_code: 'BLDG', name: 'Private building' },
    { ...busan, postcodes: ['private'], private_address: 'not returned' },
    { ...seoul, id: 16, latitude: 120 }, { ...seoul, id: 17, name: '<b>unsafe</b>' }] }) });
  const places = await f.service.searchPlaces('서울');
  assert.deepEqual(places[0], location);
  assert.equal(places.length, 2);
  assert.equal(places[1].lat, 35.1);
  assert.equal(places[1].postcodes, undefined);
  assert.equal(f.calls[0].url.searchParams.get('language'), 'en');
  assert.equal(f.calls[0].url.searchParams.get('name'), 'Seoul');
  assert.match(f.calls[0].options.headers['User-Agent'], /^Still\//);
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  for (const query of ['1 Main Street', '서울 101호', 'person@example.org', '37.5, 127.0', 'https://example.org', 'a']) {
    await assert.rejects(f.service.searchPlaces(query), error => error.status === 400);
  }
  assert.equal(f.calls.length, 1, 'rejected inputs never leave this server');
});

test('search requests coalesce, cache empty results, return copies, and evict bounded entries', async () => {
  const f = fixture();
  const service = createPlaceNewsService({ ...f.options, cacheEntries: 2 });
  const [one, two] = await Promise.all([service.searchPlaces('Seoul'), service.searchPlaces(' Seoul ')]);
  assert.equal(f.calls.length, 1);
  one[0].label = 'modified';
  assert.equal(two[0].label, location.label);
  assert.equal((await service.searchPlaces('seoul'))[0].label, location.label);
  await service.searchPlaces('Busan'); await service.searchPlaces('Paris'); await service.searchPlaces('Seoul');
  assert.equal(f.calls.length, 4);
  f.state.geo = () => Response.json({ generationtime_ms: 1 });
  assert.deepEqual(await service.searchPlaces('Unknown'), []);
  assert.deepEqual(await service.searchPlaces('Unknown'), []);
  assert.equal(f.calls.length, 5);
});

test('known Korean city aliases change only the provider query and other names remain untouched', async () => {
  const f = fixture({ geo: () => Response.json({ generationtime_ms: 1 }) });
  for (const [input, expected] of [
    ['서울', 'Seoul'], ['서울시', 'Seoul'], ['서울특별시', 'Seoul'],
    ['부산', 'Busan'], ['부산광역시', 'Busan'], ['인천', 'Incheon'], ['대구광역시', 'Daegu'],
    ['대전', 'Daejeon'], ['광주광역시', 'Gwangju'], ['울산', 'Ulsan'], ['세종특별자치시', 'Sejong'],
    ['키이우', 'Kyiv'], ['가자', 'Gaza'], ['가자시', 'Gaza'],
    ['전주', '전주'], ['서울 강남', '서울 강남'], ['Kyiv, Ukraine', 'Kyiv, Ukraine'],
  ]) {
    assert.deepEqual(await f.service.searchPlaces(input), [], 'aliases never manufacture a location');
    assert.ok(f.calls.some(call => call.url.searchParams.get('name') === expected));
  }
  assert.equal(f.calls.filter(call => call.url.searchParams.get('name') === 'Seoul').length, 1, 'aliases share the canonical-query cache');
  assert.equal(f.calls.filter(call => call.url.searchParams.get('name') === 'Gaza').length, 1);
});

test('selected location and news terms are canonical GeoNames values, ignoring forged client fields', async () => {
  const f = fixture();
  const forged = { ...location, label: 'Private residence', region: 'secret', lat: 1.234567,
    newsQuery: 'secret-address domain:attacker.example.org' };
  assert.deepEqual(await f.service.resolveLocation(forged), location);
  assert.equal(f.calls[0].url.pathname, '/v1/get');
  assert.equal(f.calls[0].url.searchParams.get('id'), '1835848');
  const news = await f.service.getNews(forged);
  assert.equal(news.query, location.newsQuery);
  assert.equal(f.calls[1].url.searchParams.get('query'), 'Seoul "South Korea"');
  assert.equal(news.coverage, '지역명 관련 기사');
  assert.equal(news.provider, 'GDELT');
  assert.equal(news.stale, false);
  assert.equal(news.articles[0].publishedAt, null);
  assert.equal(news.articles[0].observedAt, '2026-11-14T01:02:03.000Z');
  assert.equal(news.observedAtLabel, '기사 수집 시각');
});

test('lookup verifies the returned id and settlement category before issuing a news query', async () => {
  for (const response of [busan, { ...seoul, feature_code: 'BLDG' }, { ...seoul, longitude: Infinity }]) {
    const f = fixture({ geo: () => Response.json(response) });
    await assert.rejects(f.service.getNews(location), error => error.status === 400 && error.code === 'INVALID_LOCATION');
    assert.equal(f.calls.length, 1);
  }
  const f = fixture({ geo: () => Response.json({ results: [seoul] }) });
  assert.deepEqual(await f.service.resolveLocation(location), location);
});

test('article references are safe, deduplicated, attributed by URL, and never invent publication dates', async () => {
  const f = fixture({ news: () => Response.json({ articles: [
    { ...article, url: 'https://news.example.org/story?utm_source=test#top', domain: 'spoofed.example.org' },
    { ...article, url: 'http://news.example.org/story' },
    { ...article, url: 'javascript:alert(1)' }, { ...article, url: 'https://user:password@news.example.org/story' },
    { ...article, url: 'http://127.0.0.1/private' }, { ...article, url: 'https://server.internal/private' },
    { ...article, url: 'https://news.example.org/second', seendate: '20260230T010203Z' },
    { ...article, url: 'https://news.example.org/third', seendate: '2026-11-13T01:02:03Z' },
    { ...article, title: '<script>bad</script>', url: 'https://news.example.org/fourth' },
  ] }) });
  const result = await f.service.getNews(location);
  assert.equal(result.articles.length, 3);
  assert.equal(result.articles[0].source, 'news.example.org');
  assert.equal(result.articles[0].url, 'https://news.example.org/story');
  assert.equal(result.articles[1].observedAt, null);
  assert.equal(result.articles[2].observedAt, '2026-11-13T01:02:03.000Z');
  assert.ok(result.articles.every(row => row.publishedAt === null));
});

test('provider failures and oversized or non-JSON responses are errors rather than invented empty news', async () => {
  for (const response of [
    () => new Response('Please limit requests to one every 5 seconds', { status: 429 }),
    () => new Response('The specified phrase is too short.', { status: 200 }),
    () => Response.json({ error: 'failed', articles: [] }),
    () => Response.json({ unexpected: true }),
    () => new Response('x', { headers: { 'content-length': String(600 * 1024) } }),
    () => new Response('x'.repeat(600 * 1024)),
    () => { throw new Error('network unavailable'); },
  ]) {
    const f = fixture({ news: response });
    await assert.rejects(f.service.getNews(location), error => error.status === 503 && error.code === 'NEWS_UNAVAILABLE');
  }
  const empty = fixture({ news: () => Response.json({}) });
  assert.deepEqual((await empty.service.getNews(location)).articles, []);
  const badGeo = fixture({ geo: () => Response.json({ message: 'upstream failed' }) });
  await assert.rejects(badGeo.service.searchPlaces('Seoul'), error => error.code === 'PLACE_SEARCH_UNAVAILABLE');
});

test('news refresh keeps a bounded stale copy on failure and marks its original fetch time', async () => {
  const f = fixture();
  const first = await f.service.getNews(location);
  first.articles[0].title = 'not cached';
  const cached = await f.service.getNews(location);
  assert.equal(cached.articles[0].title, article.title);
  assert.equal(f.calls.length, 2);
  f.advance(16 * 60000); f.state.newsFailure = true;
  const stale = await f.service.getNews(location);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, cached.fetchedAt);
  assert.equal(stale.query, location.newsQuery);
  assert.match(stale.warning, /이전 결과/);
  f.advance(24 * 3600000);
  await assert.rejects(f.service.getNews(location), error => error.code === 'NEWS_UNAVAILABLE');
});

test('shared provider queues serialize factories, space requests, and bound bursts', async () => {
  const f = fixture();
  const second = createPlaceNewsService(f.options);
  const burst = await Promise.allSettled([
    f.service.searchPlaces('Seoul'), second.searchPlaces('Busan'),
    f.service.searchPlaces('Paris'), second.searchPlaces('Berlin'),
  ]);
  assert.equal(burst.filter(value => value.status === 'fulfilled').length, 2);
  assert.equal(burst[3].reason.status, 429);
  assert.ok(f.calls[1].at - f.calls[0].at >= 1000);
  await Promise.all([f.service.getNews(location), second.getNews({ id: `geonames:${busan.id}` })]);
  const newsCalls = f.calls.filter(call => call.url.hostname === 'api.gdeltproject.org');
  assert.equal(newsCalls.length, 2);
  assert.ok(newsCalls[1].at - newsCalls[0].at >= 5100);
});

test('provider endpoints cannot be supplied as credentials, insecure URLs, or private network targets', () => {
  for (const url of ['http://geo.example.org/v1/search', 'https://a:b@geo.example.org/v1/search',
    'https://127.0.0.1/v1/search', 'https://localhost/v1/search', 'https://geo.internal/v1/search',
    'https://geo.example.org/v1/search?api_key=secret', 'https://geo.example.org/v1/other']) {
    assert.throws(() => createPlaceNewsService({ geocodingUrl: url }));
  }
  assert.throws(() => createPlaceNewsService({ newsUrl: 'https://attacker.example.org/rss/search' }));
  assert.throws(() => createPlaceNewsService({ newsProvider: 'unknown-provider' }));
});

const rss = (...items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google News</title>${items.join('')}</channel></rss>`;
const rssItem = ({ title = 'Seoul &amp; Busan community news', link = 'https://news.google.com/rss/articles/CBMi-test?oc=5',
  source = 'Example &amp; Local', date = 'Sat, 14 Nov 2026 01:02:03 GMT' } = {}) =>
  `<item><title>${title}</title><link>${link}</link><source url="https://publisher.example.org">${source}</source><pubDate>${date}</pubDate></item>`;

test('default Google News reader uses canonical search and feed-attributed publication dates', async () => {
  const f = fixture({ newsProvider: 'google-rss', news: () => new Response(rss(rssItem(),
    rssItem({ title: '<![CDATA[서울의 일상 · 지역 소식]]>', link: 'https://news.google.com/rss/articles/CBMi-second', source: '지역&#32;신문' }))) });
  const { newsProvider, ...defaultOptions } = f.options;
  const service = createPlaceNewsService(defaultOptions);
  const result = await service.getNews(location);
  assert.equal(result.provider, 'Google News');
  assert.equal(result.query, location.newsQuery);
  assert.equal(result.sourceUrl, 'https://news.google.com/');
  assert.equal(result.dateSource, 'Google News 피드 게시 시각');
  assert.equal(result.articles.length, 2);
  assert.equal(result.articles[0].title, 'Seoul & Busan community news');
  assert.equal(result.articles[0].source, 'Example & Local');
  assert.equal(result.articles[0].publishedAt, '2026-11-14T01:02:03.000Z');
  assert.equal(result.articles[0].observedAt, null);
  assert.equal(result.articles[1].title, '서울의 일상 · 지역 소식');
  assert.equal(result.articles[1].source, '지역 신문');
  const request = f.calls.find(call => call.url.hostname === 'news.google.com');
  assert.equal(request.url.pathname, '/rss/search');
  assert.equal(request.url.searchParams.get('q'), 'Seoul "South Korea" when:7d');
  assert.equal(request.url.searchParams.get('ceid'), 'KR:ko');
  assert.match(request.options.headers.Accept, /rss\+xml/);
});

test('RSS references deduplicate, restrict links to the official feed, and leave invalid dates unknown', async () => {
  const f = fixture({ newsProvider: 'google-rss', news: () => new Response(rss(
    rssItem(), rssItem(), rssItem({ link: 'https://attacker.example.org/story' }),
    rssItem({ link: 'javascript:alert(1)' }), rssItem({ link: 'https://news.google.com.evil.example.org/rss/articles/CBMi' }),
    rssItem({ link: 'https://news.google.com/rss/articles/CBMi-third', date: 'Mon, 30 Feb 2026 00:00:00 GMT' }),
    rssItem({ link: 'https://news.google.com/rss/articles/CBMi-bad', title: '<![CDATA[<script>alert(1)</script>]]>' }),
  )) });
  const result = await f.service.getNews(location);
  assert.equal(result.articles.length, 2);
  assert.equal(result.articles[1].publishedAt, null);
  assert.ok(result.articles.every(row => row.url.startsWith('https://news.google.com/')));
});

test('RSS sorts validated dates newest first before limiting and retains stable ties with unknown dates last', async () => {
  const item = (id, day) => rssItem({ title: id, link: `https://news.google.com/rss/articles/${id}`,
    date: day ? new Date(`2026-11-${day}T01:00:00Z`).toUTCString() : 'unknown' });
  const ordered = fixture({ newsProvider: 'google-rss', news: () => new Response(rss(
    item('unknown-first', null), item('old-first', '10'), item('new-second', '12'), item('new-tie', '12'),
  )) });
  assert.deepEqual((await ordered.service.getNews(location)).articles.map(row => row.title),
    ['new-second', 'new-tie', 'old-first', 'unknown-first']);

  const capped = fixture({ newsProvider: 'google-rss', news: () => new Response(rss(
    ...Array.from({ length: 12 }, (_, index) => item(`old-${index}`, '10')), item('new-after-twelve', '13'),
  )) });
  const articles = (await capped.service.getNews(location)).articles;
  assert.equal(articles.length, 12);
  assert.equal(articles[0].title, 'new-after-twelve');
  assert.equal(articles[1].title, 'old-0');
  assert.equal(articles.at(-1).title, 'old-10');
});

test('RSS parser refuses DTDs, unknown entities, malformed feeds, and oversized responses', async () => {
  for (const body of [
    '<html><body>Service unavailable</body></html>',
    '<!DOCTYPE rss [<!ENTITY leak SYSTEM "file:///etc/passwd">]>' + rss(rssItem({ title: '&leak;' })),
    rss(rssItem({ title: '&unknown;' })), rss(rssItem({ title: '&#xD800;' })),
    '<rss><channel><item><title>truncated</title></channel></rss>',
    rss(rssItem()).slice(0, -6), 'x'.repeat(600 * 1024),
  ]) {
    const f = fixture({ newsProvider: 'google-rss', news: () => new Response(body) });
    await assert.rejects(f.service.getNews(location), error => error.status === 503 && error.code === 'NEWS_UNAVAILABLE');
  }
  const empty = fixture({ newsProvider: 'google-rss', news: () => new Response(rss()) });
  assert.deepEqual((await empty.service.getNews(location)).articles, []);
});

test('Google RSS failures retain marked cached results without fetching article destinations', async () => {
  const f = fixture({ newsProvider: 'google-rss', news: () => new Response(rss(rssItem())) });
  const first = await f.service.getNews(location);
  f.advance(16 * 60000); f.state.newsFailure = true;
  const stale = await f.service.getNews(location);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.equal(stale.articles[0].publishedAt, first.articles[0].publishedAt);
  assert.ok(f.calls.every(call => ['geocoding-api.open-meteo.com', 'news.google.com'].includes(call.url.hostname)));
});
