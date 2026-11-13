// The map excerpts share the same 700 × 408 crop at (40, 760) on page 1 rendered at 210 dpi.
const observations = [
  {
    date: '2025-07-08',
    structures: 3202,
    map: '/unosat-al-shati-2025-07-08.webp',
    imageryCredit: 'Maxar · CNES',
    source: 'https://unosat.org/products/4165',
    report: 'https://unosat.org/static/unosat_filesystem/4165/OCHA-OPT-027_UNOSAT_A3_Gaza_Strip_OPT_CDA_08072025.pdf',
  },
  {
    date: '2025-10-11',
    structures: 3465,
    map: '/unosat-al-shati-2025-10-11.webp',
    imageryCredit: 'Vantor · CNES',
    source: 'https://unosat.org/products/4213',
    report: 'https://unosat.org/static/unosat_filesystem/4213/OCHA-CBPF-OPT-031_UNOSAT_A3_GazaStrip_CDA_11October2025.pdf',
  },
];

function dateLabel(date) {
  const [year, month, day] = date.split('-');
  return `${year}. ${month}. ${day}.`;
}

const number = new Intl.NumberFormat('ko-KR');

function observationCard({ date, source, structures }, index) {
  return `<article class="home-observation" data-observation="${index}">
    <div>
      <time datetime="${date}">${dateLabel(date)}</time>
      <p>영향을 받은 구조물 <strong>${number.format(structures)}개</strong></p>
    </div>
    <a href="${source}" target="_blank" rel="noopener noreferrer" aria-label="${dateLabel(date)} UNOSAT 관측 자료">UNOSAT 원문</a>
  </article>`;
}

function renderResidence(container, home, api) {
  const residence = container.querySelector('.home-residence');
  const areaName = container.querySelector('.home-area-name');
  areaName.textContent = home?.neighborhood || '가자시 알샤티';
  residence.hidden = !home;
  if (!home) return;

  const status = container.querySelector('.home-evidence-status');
  status.textContent = home.status;
  const details = container.querySelector('.home-building-observation');
  const observation = home.buildingObservation;
  details.hidden = !observation;
  if (observation) {
    const date = details.querySelector('time');
    date.dateTime = observation.date;
    date.textContent = dateLabel(observation.date);
    const source = details.querySelector('a');
    source.hidden = true;
    source.removeAttribute('href');
    try {
      const url = new URL(observation.source);
      if (url.protocol === 'https:') {
        source.href = url.href;
        source.hidden = false;
      }
    } catch {
      // A stored observation can still display its date if its source URL is invalid.
    }
  }

  const privacy = container.querySelector('.home-address-privacy');
  const address = container.querySelector('.home-address-value');
  const edit = container.querySelector('.home-address-edit');
  if (!home.canEdit) {
    privacy.textContent = '상세 주소는 등록자만 열람';
    return;
  }

  privacy.textContent = '상세 주소 · 나만 열람';
  address.hidden = !home.hasAddress;
  address.textContent = home.address;
  edit.hidden = false;
  edit.textContent = home.hasAddress ? '주소 수정' : '주소 등록';

  const form = container.querySelector('.home-address-form');
  const field = form.elements.address;
  const message = container.querySelector('.home-address-message');
  edit.onclick = () => {
    field.value = address.textContent;
    message.textContent = '';
    form.hidden = false;
    edit.hidden = true;
    field.focus();
  };
  form.querySelector('[data-home-cancel]').onclick = () => {
    form.hidden = true;
    edit.hidden = false;
    edit.focus();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const addressInput = field.value.trim();
    if (!addressInput) {
      message.textContent = '상세 주소를 입력해 주세요.';
      field.focus();
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    const cancel = form.querySelector('[data-home-cancel]');
    submit.disabled = true;
    cancel.disabled = true;
    message.textContent = '저장 중…';
    try {
      const { home: saved } = await api('/api/home', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addressInput }),
      });
      if (!form.isConnected) return;
      renderResidence(container, saved, api);
      form.hidden = true;
      message.textContent = '주소를 저장했습니다.';
      edit.focus();
    } catch {
      message.textContent = '저장하지 못했습니다. 연결을 확인해 주세요.';
    } finally {
      submit.disabled = false;
      cancel.disabled = false;
    }
  };
}

export function initHome(container, { api }) {
  container.innerHTML = `<section class="home-panel" aria-labelledby="home-title">
    <header class="home-intro">
      <h1 id="home-title">집 주변 관측</h1>
    </header>
    <div class="home-layout">
      <section class="home-card home-neighborhood" aria-labelledby="home-map-title">
        <div class="home-card-heading">
          <h2 id="home-map-title" class="home-area-name">가자시 알샤티</h2>
          <span class="home-map-legend" aria-label="빨간색이 짙을수록 높은 피해 밀도"><span aria-hidden="true"></span>피해 밀도</span>
        </div>
        <div class="home-date-select" role="group" aria-label="지도 관측일">
          ${observations.map(({ date }, index) => `<button type="button" data-home-date="${index}" aria-pressed="false"><time datetime="${date}">${dateLabel(date)}</time></button>`).join('')}
        </div>
        <figure class="home-map-figure">
          <div class="home-map">
            <img class="home-map-image" width="700" height="408" alt="">
          </div>
          <figcaption>
            <a class="home-map-source" target="_blank" rel="noopener noreferrer">UNOSAT 원본</a>
            <span>위성영상 © <span class="home-map-credit"></span></span>
          </figcaption>
        </figure>
        <div class="home-map-controls">
          <button type="button" class="home-map-detail-button" aria-expanded="false" aria-controls="home-map-result">박현준 관측 결과 보여줘</button>
          <p class="home-map-result" id="home-map-result" role="status" hidden></p>
        </div>
      </section>
      <div class="home-details">
        <section class="home-card home-residence" hidden aria-labelledby="home-residence-title">
          <div class="home-card-heading">
            <h2 id="home-residence-title">등록 거주지</h2>
          </div>
          <p class="home-evidence-status"></p>
          <p class="home-building-observation" hidden>
            관측일 <time></time> · <a target="_blank" rel="noopener noreferrer">출처 보기</a>
          </p>
          <div class="home-address">
            <p class="home-address-label"><span class="home-address-privacy"></span></p>
            <div class="home-address-row">
              <p class="home-address-value" hidden></p>
              <button class="home-address-edit" type="button" hidden>주소 수정</button>
            </div>
            <form class="home-address-form" hidden>
              <label for="home-address">상세 주소</label>
              <input id="home-address" name="address" maxlength="200" required autocomplete="off">
              <div class="home-form-actions">
                <button type="button" data-home-cancel>취소</button>
                <button type="submit">저장</button>
              </div>
            </form>
            <p class="home-address-message" role="status"></p>
          </div>
        </section>
        <p class="home-load-status" role="status"></p>
        <section class="home-card" aria-labelledby="home-observations-title">
          <div class="home-card-heading">
            <h2 id="home-observations-title">관측 기록</h2>
          </div>
          <div class="home-observation-list">${observations.map(observationCard).join('')}</div>
          <p class="home-note">현장 검증 전 위성 분석입니다. 피해 가능성을 포함한 수치입니다.</p>
        </section>
      </div>
    </div>
  </section>`;

  const dateButtons = [...container.querySelectorAll('[data-home-date]')];
  const cards = [...container.querySelectorAll('[data-observation]')];
  const mapImage = container.querySelector('.home-map-image');
  const mapSource = container.querySelector('.home-map-source');
  const mapCredit = container.querySelector('.home-map-credit');
  const mapPin = container.querySelector('.home-map-detail-button');
  const mapPopup = container.querySelector('.home-map-result');

  function selectDate(selected) {
    for (const [index, button] of dateButtons.entries()) {
      button.setAttribute('aria-pressed', String(index === selected));
      cards[index].classList.toggle('home-observation-selected', index === selected);
    }
    const { date, structures, map, report, imageryCredit } = observations[selected];
    mapImage.src = map;
    mapImage.alt = `${dateLabel(date)} 알샤티와 가자시 주변의 UNOSAT 피해 밀도 지도`;
    mapSource.href = report;
    mapCredit.textContent = imageryCredit;
    mapPopup.textContent = `${dateLabel(date)} 관측 · 알샤티에서 영향을 받은 구조물 ${number.format(structures)}개`;
  }

  for (const [index, button] of dateButtons.entries()) {
    button.onclick = () => selectDate(index);
  }
  mapPin.onclick = () => {
    mapPopup.hidden = !mapPopup.hidden;
    mapPin.setAttribute('aria-expanded', String(!mapPopup.hidden));
  };
  selectDate(1);

  const loadStatus = container.querySelector('.home-load-status');
  async function loadResidence() {
    loadStatus.textContent = '거주지 불러오는 중…';
    try {
      const { home } = await api('/api/home');
      if (!loadStatus.isConnected) return;
      renderResidence(container, home, api);
      loadStatus.hidden = true;
    } catch {
      loadStatus.textContent = '거주지를 불러오지 못했습니다. ';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '다시 시도';
      retry.onclick = loadResidence;
      loadStatus.append(retry);
    }
  }

  return loadResidence();
}
