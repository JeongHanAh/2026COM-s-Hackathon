import { commandLabel } from './easter-egg.js';

// Fixed demonstration material, never observations of the family's selected region.
const observations = [
  { date: '2025-07-08', structures: 3202, map: '/unosat-al-shati-2025-07-08.webp', imageryCredit: 'Maxar · CNES',
    source: 'https://unosat.org/products/4165', report: 'https://unosat.org/static/unosat_filesystem/4165/OCHA-OPT-027_UNOSAT_A3_Gaza_Strip_OPT_CDA_08072025.pdf' },
  { date: '2025-10-11', structures: 3465, map: '/unosat-al-shati-2025-10-11.webp', imageryCredit: 'Vantor · CNES',
    source: 'https://unosat.org/products/4213', report: 'https://unosat.org/static/unosat_filesystem/4213/OCHA-CBPF-OPT-031_UNOSAT_A3_GazaStrip_CDA_11October2025.pdf' }
];
const number = new Intl.NumberFormat('ko-KR');
const dateLabel = value => value.split('-').join('. ') + '.';
const collectedDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const checkedDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function asDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function asLocation(value) {
  if (!value || !['string', 'number'].includes(typeof value.id) || !String(value.id).trim()
    || (typeof value.id === 'number' && !Number.isFinite(value.id))
    || typeof value.label !== 'string' || !value.label.trim()
    || typeof value.newsQuery !== 'string' || !value.newsQuery.trim()
    || typeof value.lat !== 'number' || !Number.isFinite(value.lat) || Math.abs(value.lat) > 90
    || typeof value.lon !== 'number' || !Number.isFinite(value.lon) || Math.abs(value.lon) > 180) return null;
  return { id: value.id, label: value.label.slice(0, 300), region: typeof value.region === 'string' ? value.region.slice(0, 200) : '',
    lat: value.lat, lon: value.lon, newsQuery: value.newsQuery.slice(0, 200) };
}

const locationKey = place => place ? JSON.stringify([place.id, place.lat, place.lon, place.newsQuery]) : '';

function mapUrls(place) {
  // Only the public centroid goes to OpenStreetMap. Never use a private address.
  const lat = Math.max(-85, Math.min(85, Math.round(place.lat * 100) / 100));
  const lon = Math.max(-180, Math.min(180, Math.round(place.lon * 100) / 100));
  const bbox = [Math.max(-180, lon - .08), Math.max(-85, lat - .05), Math.min(180, lon + .08), Math.min(85, lat + .05)];
  const embed = new URL('https://www.openstreetmap.org/export/embed.html');
  embed.search = new URLSearchParams({ bbox: bbox.map(value => value.toFixed(3)).join(','), layer: 'mapnik' });
  return { embed: embed.href, link: `https://www.openstreetmap.org/#map=11/${lat.toFixed(2)}/${lon.toFixed(2)}` };
}

function externalLink(label, href) {
  const link = document.createElement('a');
  link.textContent = label;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function drawMap(target, place) {
  target.replaceChildren();
  if (!place) return;
  const urls = mapUrls(place);
  const frame = document.createElement('iframe');
  frame.title = place.label + ' 지역 지도';
  frame.src = urls.embed;
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
  frame.className = 'home-region-map';
  const footer = document.createElement('div');
  footer.className = 'home-map-attribution';
  footer.append(externalLink('지도 크게 보기', urls.link), externalLink('© OpenStreetMap', 'https://www.openstreetmap.org/copyright'));
  target.append(frame, footer);
}

function renderObservationExample(root) {
  const buttons = [...root.querySelectorAll('[data-home-date]')];
  const result = root.querySelector('.home-map-result');
  const detail = root.querySelector('.home-map-detail-button');
  function select(index) {
    const observation = observations[index];
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    const map = root.querySelector('.home-map-image');
    map.src = observation.map;
    map.alt = `${dateLabel(observation.date)} 가자시 알샤티의 UNOSAT 피해 밀도 관측 예시`;
    root.querySelector('.home-map-source').href = observation.report;
    root.querySelector('.home-map-credit').textContent = observation.imageryCredit;
    root.querySelector('.home-observation-original').href = observation.source;
    result.textContent = `${dateLabel(observation.date)} 관측 · 영향을 받은 구조물 ${number.format(observation.structures)}개`;
  }
  buttons.forEach((button, index) => { button.onclick = () => select(index); });
  detail.onclick = () => { result.hidden = !result.hidden; detail.setAttribute('aria-expanded', String(!result.hidden)); };
  select(1);
}

export function initHome(container, { api }) {
  // Only fixed markup enters innerHTML. Provider fields use textContent or validated URLs.
  container.innerHTML = `<section class="home-panel" aria-labelledby="home-title">
    <header class="home-intro"><h1 id="home-title">집 주변 소식</h1></header>
    <div class="home-load-state" role="status"><p class="home-load-message">지역을 불러오는 중…</p><button class="text-button" type="button" data-home-retry hidden>다시 불러오기</button></div>
    <section class="home-region-section" aria-labelledby="home-region-title" hidden>
      <div class="home-region-heading"><div><p class="home-eyebrow">함께 보는 지역</p><h2 id="home-region-title"></h2></div><button class="text-button home-region-edit" type="button" hidden>지역 변경</button></div>
      <p class="home-region-empty" hidden></p><div class="home-saved-map" hidden></div>
      <div class="home-location-editor" hidden>
        <form class="home-search-form"><label for="home-region-query">지역 이름</label>
          <div class="home-search-row"><input id="home-region-query" name="query" type="search" minlength="2" maxlength="100" placeholder="서울 또는 Kyiv" autocomplete="off" aria-describedby="home-search-help" required><button class="button outline" type="submit">지역 찾기</button></div>
          <p id="home-search-help" class="home-help">도시·지역 이름으로 검색 · 이 공간의 멤버에게 공개됩니다.</p>
        </form><p class="home-search-message" role="status"></p><div class="home-search-results" role="group" aria-label="지역 검색 결과"></div>
        <div class="home-candidate" hidden><p class="home-eyebrow">선택한 지역</p><h3 class="home-candidate-name"></h3><p class="home-help">지역 중심을 확인해 주세요.</p><div class="home-candidate-map"></div>
          <div class="home-form-actions"><button class="button primary easter-button home-location-save" type="button" aria-label="지역 저장">${commandLabel('지역 저장', '박현준 지역 저장해줘')}</button></div>
        </div><p class="home-location-message" role="status"></p>
        <div class="home-editor-footer"><span class="home-provider-credit">지역 검색: <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> / <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a></span><button class="text-button home-location-cancel" type="button" hidden>취소</button></div>
      </div>
    </section>
    <section class="home-news-section" aria-labelledby="home-news-title" hidden>
      <div class="home-card-heading"><h2 id="home-news-title">지역 소식</h2><button class="text-button home-news-refresh" type="button">다시 불러오기</button></div>
      <p class="home-news-coverage">지역명을 언급한 기사 · 우리 집 상태 미확인</p><p class="home-news-state" role="status"></p><p class="home-news-updated"></p><ul class="home-news-list"></ul>
      <p class="home-news-credit" hidden>기사 검색: <a class="home-news-provider" target="_blank" rel="noopener noreferrer"></a></p>
    </section>
    <details class="home-private-address" hidden><summary>상세 주소 · 나만 보기</summary><div class="home-address">
      <div class="home-address-row"><p class="home-address-value"></p><button class="text-button home-address-edit" type="button">주소 등록</button></div>
      <form class="home-address-form" hidden><label for="home-address">상세 주소</label><input id="home-address" name="address" maxlength="200" required autocomplete="off" aria-describedby="home-address-help"><p id="home-address-help" class="home-help">지역 검색이나 기사 검색에 사용하지 않습니다.</p>
        <div class="home-form-actions"><button class="text-button" type="button" data-home-address-cancel>취소</button><button class="button primary" type="submit">주소 저장</button></div>
      </form><p class="home-address-message" role="status"></p>
    </div></details>
    <details class="home-observation-example"><summary>관측 예시 · 가자시 알샤티</summary><div class="home-example-content">
      <p class="home-example-note">등록한 지역과 별개인 UNOSAT 관측 자료입니다.</p>
      <div class="home-card-heading"><h2>가자시 알샤티</h2><span class="home-map-legend"><span aria-hidden="true"></span>피해 밀도</span></div>
      <div class="home-date-select" role="group" aria-label="예시 지도 관측일">${observations.map(({ date }, index) => `<button type="button" data-home-date="${index}" aria-pressed="false"><time datetime="${date}">${dateLabel(date)}</time></button>`).join('')}</div>
      <figure class="home-map-figure"><div class="home-map"><img class="home-map-image" width="700" height="408" loading="lazy" alt=""></div><figcaption><a class="home-map-source" target="_blank" rel="noopener noreferrer">UNOSAT 원본</a><span>위성영상 © <span class="home-map-credit"></span></span></figcaption></figure>
      <div class="home-map-controls"><button type="button" class="button outline home-map-detail-button easter-button" aria-label="관측 결과 보기" aria-expanded="false" aria-controls="home-map-result">${commandLabel('관측 결과 보기', '박현준 관측 결과 보여줘')}</button><p class="home-map-result" id="home-map-result" role="status" hidden></p></div>
      <p class="home-note">동네 피해 관측 · 우리 집 상태 미확인<br>현장 검증 전 위성 분석입니다. <a class="home-observation-original" target="_blank" rel="noopener noreferrer">자료 출처</a></p>
    </div></details>
  </section>`;

  const root = container.firstElementChild;
  const $ = selector => root.querySelector(selector);
  const alive = () => root.isConnected && container.firstElementChild === root;
  let home = null, selected = null, editing = false, mutating = false;
  let homeVersion = 0, searchVersion = 0, newsVersion = 0;
  let newsNeedsHome = false;
  const region = $('.home-region-section'), editor = $('.home-location-editor');
  const searchForm = $('.home-search-form'), queryField = searchForm.elements.query;
  const searchMessage = $('.home-search-message'), results = $('.home-search-results');
  const newsSection = $('.home-news-section'), newsState = $('.home-news-state'), newsList = $('.home-news-list');
  const addressForm = $('.home-address-form'), addressField = addressForm.elements.address;
  const setMessage = (element, text, error = false) => { element.textContent = text; element.classList.toggle('home-message-error', error); };

  function showEditor(show) {
    editing = show && home?.canEdit === true;
    ++searchVersion;
    selected = null;
    results.replaceChildren();
    $('.home-candidate-map').replaceChildren();
    $('.home-candidate').hidden = true;
    setMessage(searchMessage, '');
    setMessage($('.home-location-message'), '');
    editor.hidden = !editing;
    $('.home-region-edit').hidden = editing || !home?.canEdit;
    $('.home-saved-map').hidden = editing || !home?.location;
    $('.home-location-cancel').hidden = !home?.location;
    $('.home-region-empty').hidden = Boolean(home?.location) || editing;
    $('.home-private-address').hidden = !home?.canEdit;
    newsSection.hidden = editing || !home?.location;
    searchForm.querySelector('[type="submit"]').disabled = mutating;
    queryField.disabled = mutating;
    $('.home-region-edit').disabled = mutating;
  }

  function applyHome(value) {
    const oldKey = locationKey(home?.location);
    home = { ...value, canEdit: value?.canEdit === true, location: asLocation(value?.location) };
    region.hidden = false;
    $('#home-region-title').textContent = home.location?.label || '지역을 등록해 주세요';
    $('.home-region-empty').textContent = '공간 소유자가 지역을 등록하면 소식을 볼 수 있어요.';
    if (oldKey !== locationKey(home.location) || !$('.home-saved-map').childElementCount) drawMap($('.home-saved-map'), home.location);
    $('.home-region-edit').textContent = home.location ? '지역 변경' : '지역 등록';
    $('.home-address-value').textContent = home.canEdit && home.hasAddress && typeof home.address === 'string' ? home.address : '';
    $('.home-address-edit').textContent = home.hasAddress ? '주소 수정' : '주소 등록';
    addressField.value = '';
    addressForm.hidden = true;
    $('.home-address-row').hidden = false;
    $('.home-private-address').open = false;
    setMessage($('.home-address-message'), '');
    if (oldKey !== locationKey(home.location)) {
      ++newsVersion;
      newsList.replaceChildren();
      setMessage(newsState, '');
      $('.home-news-updated').textContent = '';
    }
    showEditor(!home.location && home.canEdit);
    return oldKey !== locationKey(home.location);
  }

  function renderArticles(articles, provider) {
    const seen = new Set();
    const fragment = document.createDocumentFragment();
    for (const article of articles.slice(0, 30)) {
      const href = safeUrl(article?.url);
      if (!href || seen.has(href) || typeof article.title !== 'string' || !article.title.trim()) continue;
      seen.add(href);
      const item = document.createElement('li');
      const link = externalLink('', href);
      link.className = 'home-news-link';
      const title = document.createElement('h3');
      title.textContent = article.title.slice(0, 600);
      const metadata = document.createElement('div');
      metadata.className = 'home-news-meta';
      const source = document.createElement('span');
      source.textContent = typeof article.source === 'string' && article.source.trim() ? article.source.slice(0, 150) : new URL(href).hostname;
      const published = asDate(article.publishedAt), observed = asDate(article.observedAt);
      metadata.append(source);
      if (published || observed) {
        const date = published || observed;
        const time = document.createElement('time');
        time.dateTime = date.toISOString();
        time.textContent = (published ? '게시 ' : '수집 ') + collectedDate.format(date);
        time.title = published && provider === 'Google News' ? 'Google News 피드 게시 시각' : published ? '기사 게시 시각' : '기사 수집 시각';
        metadata.append(time);
      }
      const open = document.createElement('span');
      open.className = 'home-news-open';
      open.textContent = '기사 보기';
      metadata.append(open);
      link.append(title, metadata);
      item.append(link);
      fragment.append(item);
    }
    newsList.replaceChildren(fragment);
    return seen.size;
  }

  async function loadNews() {
    if (!alive() || !home?.location) return;
    const version = ++newsVersion, key = locationKey(home.location), expectedQuery = home.location.newsQuery;
    newsNeedsHome = false;
    newsSection.setAttribute('aria-busy', 'true');
    $('.home-news-refresh').disabled = true;
    $('.home-news-updated').textContent = '';
    $('.home-news-credit').hidden = true;
    newsList.replaceChildren();
    newsState.classList.remove('home-news-stale');
    setMessage(newsState, '소식을 불러오는 중…');
    try {
      const { news } = await api('/api/home/news');
      if (!alive() || version !== newsVersion || key !== locationKey(home?.location)) return;
      if (!news || !Array.isArray(news.articles) || typeof news.query !== 'string') throw new Error('invalid news');
      if (news.query !== expectedQuery) { newsNeedsHome = true; throw new Error('region changed'); }
      const count = renderArticles(news.articles, news.provider);
      setMessage(newsState, news.stale ? (count ? '저장된 소식을 보고 있습니다.' : '저장된 소식에 기사가 없습니다.') : count ? '' : '이 지역의 기사를 찾지 못했습니다.');
      newsState.classList.toggle('home-news-stale', news.stale === true);
      const fetchedAt = asDate(news.fetchedAt);
      $('.home-news-updated').textContent = fetchedAt ? `마지막 확인 ${checkedDate.format(fetchedAt)}` : '';
      const provider = $('.home-news-provider');
      const providerUrl = { 'GDELT': 'https://www.gdeltproject.org/', 'Google News': 'https://news.google.com/' }[news.provider];
      if (providerUrl) { provider.textContent = news.provider; provider.href = providerUrl; }
      $('.home-news-credit').hidden = !providerUrl;
    } catch (error) {
      if (!alive() || version !== newsVersion || key !== locationKey(home?.location)) return;
      if (['HOME_CHANGED', 'HOME_LOCATION_REQUIRED'].includes(error?.code)) newsNeedsHome = true;
      setMessage(newsState, newsNeedsHome ? '등록 지역이 바뀌었습니다. 다시 불러와 주세요.' : '지금 소식을 불러올 수 없습니다. 다시 시도해 주세요.', true);
      newsState.classList.remove('home-news-stale');
    } finally {
      if (alive() && version === newsVersion) {
        newsSection.setAttribute('aria-busy', 'false');
        $('.home-news-refresh').disabled = false;
      }
    }
  }

  async function loadHome() {
    const version = ++homeVersion;
    $('.home-load-state').hidden = false;
    $('[data-home-retry]').hidden = true;
    setMessage($('.home-load-message'), '지역을 불러오는 중…');
    try {
      const result = await api('/api/home');
      if (!alive() || version !== homeVersion) return;
      if (!result || !result.home) throw new Error('invalid home');
      applyHome(result.home);
      $('.home-load-state').hidden = true;
      if (home.location) await loadNews();
    } catch {
      if (!alive() || version !== homeVersion) return;
      setMessage($('.home-load-message'), '지역을 불러오지 못했습니다.', true);
      $('[data-home-retry]').hidden = false;
    }
  }

  function setMutation(active) {
    mutating = active;
    for (const control of root.querySelectorAll('.home-location-editor button, .home-location-editor input, .home-address-form button, .home-address-form input, .home-address-edit, .home-region-edit')) control.disabled = active;
  }

  async function denied(error) {
    if (!alive() || ![401, 403].includes(error?.status)) return;
    applyHome({ ...home, canEdit: false, address: undefined });
    await loadHome();
  }

  $('.home-region-edit').onclick = () => { if (!mutating) { showEditor(true); queryField.focus(); } };
  $('.home-location-cancel').onclick = () => {
    if (!mutating) { showEditor(false); $('.home-region-edit').focus(); if (home?.location) void loadNews(); }
  };
  $('[data-home-retry]').onclick = loadHome;
  $('.home-news-refresh').onclick = () => newsNeedsHome ? loadHome() : loadNews();

  searchForm.onsubmit = async event => {
    event.preventDefault();
    if (mutating || !home?.canEdit) return;
    const query = queryField.value.trim();
    if (query.length < 2) { setMessage(searchMessage, '도시·지역 이름을 두 글자 이상 입력해 주세요.', true); return; }
    const version = ++searchVersion;
    selected = null;
    $('.home-candidate').hidden = true;
    $('.home-candidate-map').replaceChildren();
    results.replaceChildren();
    setMessage($('.home-location-message'), '');
    setMessage(searchMessage, '지역을 찾는 중…');
    const submit = searchForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const payload = await api('/api/home/search', { method: 'POST', json: { query } });
      if (!alive() || version !== searchVersion || !editing) return;
      if (!Array.isArray(payload?.places)) throw new Error('invalid places');
      const places = payload.places.map(asLocation).filter(Boolean).slice(0, 8);
      setMessage(searchMessage, places.length ? '지도에서 확인할 지역을 선택해 주세요.' : '검색 결과가 없습니다. Seoul, Kyiv처럼 영문 도시명으로도 찾아보세요.');
      for (const place of places) {
        const button = document.createElement('button');
        button.className = 'home-place-option';
        button.type = 'button';
        button.setAttribute('aria-pressed', 'false');
        const name = document.createElement('strong');
        name.textContent = place.label;
        button.append(name);
        if (place.region && !place.label.includes(place.region)) {
          const detail = document.createElement('span');
          detail.textContent = place.region;
          button.append(detail);
        }
        button.onclick = () => {
          if (mutating || !home?.canEdit || version !== searchVersion) return;
          selected = place;
          for (const option of results.children) option.setAttribute('aria-pressed', String(option === button));
          $('.home-candidate-name').textContent = place.label;
          drawMap($('.home-candidate-map'), place);
          $('.home-candidate').hidden = false;
          setMessage($('.home-location-message'), '');
        };
        results.append(button);
      }
    } catch (error) {
      if (!alive() || version !== searchVersion) return;
      setMessage(searchMessage, '지역을 찾지 못했습니다. 잠시 뒤 다시 시도해 주세요.', true);
      await denied(error);
    } finally { if (alive() && version === searchVersion) submit.disabled = false; }
  };

  $('.home-location-save').onclick = async () => {
    if (mutating || !selected || !home?.canEdit) return;
    const version = ++homeVersion, place = selected;
    ++newsVersion;
    setMutation(true);
    setMessage($('.home-location-message'), '지역 저장 중…');
    try {
      const result = await api('/api/home/location', { method: 'PUT', json: { location: place } });
      if (!alive() || version !== homeVersion) return;
      if (!result?.home || !asLocation(result.home.location)) throw new Error('invalid location');
      applyHome(result.home);
      $('.home-load-state').hidden = true;
      await loadNews();
    } catch (error) {
      if (!alive() || version !== homeVersion) return;
      setMessage($('.home-location-message'), '지역을 저장하지 못했습니다. 다시 시도해 주세요.', true);
      await denied(error);
    } finally { if (alive()) setMutation(false); }
  };

  $('.home-address-edit').onclick = () => {
    if (mutating || !home?.canEdit) return;
    addressField.value = home.hasAddress && typeof home.address === 'string' ? home.address : '';
    addressForm.hidden = false;
    $('.home-address-row').hidden = true;
    setMessage($('.home-address-message'), '');
    addressField.focus();
  };
  $('[data-home-address-cancel]').onclick = () => { if (!mutating) { addressForm.hidden = true; $('.home-address-row').hidden = false; $('.home-address-edit').focus(); } };
  addressForm.onsubmit = async event => {
    event.preventDefault();
    if (mutating || !home?.canEdit) return;
    const address = addressField.value.trim();
    if (!address) { setMessage($('.home-address-message'), '상세 주소를 입력해 주세요.', true); return; }
    const version = ++homeVersion;
    setMutation(true);
    setMessage($('.home-address-message'), '주소 저장 중…');
    try {
      const result = await api('/api/home', { method: 'PUT', json: { address } });
      if (!alive() || version !== homeVersion) return;
      if (!result?.home) throw new Error('invalid home');
      const changed = applyHome(result.home);
      $('.home-private-address').open = true;
      setMessage($('.home-address-message'), '주소를 저장했습니다.');
      if (changed) await loadNews();
    } catch (error) {
      if (!alive() || version !== homeVersion) return;
      setMessage($('.home-address-message'), '주소를 저장하지 못했습니다. 다시 시도해 주세요.', true);
      await denied(error);
    } finally { if (alive()) setMutation(false); }
  };

  renderObservationExample(root);
  return loadHome();
}
