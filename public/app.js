import { icon } from './icons.js';
import * as device from './device.js';
import { readDevice, writeDevice, readOutbox, savePending, readDeletions, queueDeletion, approvePending } from './device.js';
import { syncRecords } from './record-sync.js';
import { initHome } from './home.js';
import { commandLabel } from './easter-egg.js';
import { timelineGroups } from './record-order.js';
import { anonymousSession, offlineSession, isNetworkFailure, validateAuthFields } from './auth-state.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#notice');
const zone = 'Asia/Seoul';
const formatter = options => new Intl.DateTimeFormat('ko-KR', { timeZone: zone, ...options });
const dateKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const dateKey = value => dateKeyFormat.format(new Date(value));
const dayLabel = value => formatter({ month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(value));
const timeLabel = value => formatter({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const startOfMonth = date => date.slice(0, 7) + '-01';
const dateAsNoon = date => new Date(date + 'T12:00:00+09:00');
const labels = { timeline: '기록', archive: '내보내기', home: '집 주변' };
const demoUsers = { a: { name: '서연', email: 'family-a@example.test' }, b: { name: '지우', email: 'family-b@example.test' } };
const state = {
  session: null, records: [], outbox: [], deletions: [], connected: navigator.onLine,
  page: 'timeline', date: '', month: startOfMonth(dateKey(Date.now())), filter: 'all', order: 'recent',
  authPage: 'login', authEmail: '', authNotice: '', serviceError: '', onboardingPage: 'choice',
  range: { from: dateKey(Date.now() - 6 * 86400000), to: dateKey(Date.now()), mode: 'mixed' }
};
let noticeTimer;
const notifiedUploads = new Set();
let stopCapture;
let syncing = false;
let syncTask;
let refreshing = false;
let renderSignature;
let previewUrl;
let modalVersion = 0;
let captureDraft;
let captureDraftUrl;
let capturePreviewTimer;
let savingCapture = false;
let starting;
let sessionVersion = 0;
const localMediaUrls = new Map();
const durationLabel = milliseconds => {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function api(path, options = {}) {
  const { json, ...request } = options;
  const sessionAtRequest = sessionVersion;
  let response;
  try {
    response = await fetch(path, {
      cache: 'no-store', credentials: 'same-origin',
      signal: AbortSignal.timeout(/^\/api\/home\/(search|location|news)$/.test(path) ? 60000 : path === '/api/records' && request.method === 'POST' ? 45000 : 12000),
      ...request,
      ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json', ...request.headers } } : {})
    });
  } catch (failure) {
    throw Object.assign(new Error('인터넷 연결을 확인해 주세요.', { cause: failure }), { network: true });
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = typeof payload.error === 'string' && /[가-힣]/.test(payload.error) ? payload.error : {
      400: '입력값을 확인해 주세요.', 401: '다시 로그인해 주세요.', 403: '이 작업을 할 권한이 없습니다.',
      404: '선택한 기록을 찾을 수 없습니다.', 409: '다른 계정으로 연결되어 있습니다.',
      422: '파일을 처리할 수 없습니다.', 429: '잠시 뒤 다시 시도해 주세요.', 503: '서버에서 파일을 만들 수 없습니다.'
    }[response.status];
    if (sessionAtRequest === sessionVersion && (
      response.status === 401 && path !== '/api/login' && state.session?.user
      || response.status === 403 && (payload.code === 'FAMILY_REQUIRED' || ['/api/session', '/api/records'].includes(path)))) await clearAccess();
    throw Object.assign(new Error(message || '요청을 처리하지 못했습니다.'), { status: response.status, code: payload.code });
  }
  if (response.status === 204) return null;
  try { return await response.json(); }
  catch { throw Object.assign(new Error('서버 응답을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'), { status: 502 }); }
}

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  noticeTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

const partition = (session = state.session) => session?.user?.id && session?.family?.id ? session.user.id + '/' + session.family.id : '';
const deleted = record => state.deletions.some(item => item.id === record.id && (item.familyId || item.partition?.split('/')[1]) === state.session?.family?.id);
const shared = () => state.records.filter(record => !deleted(record));
const mine = () => state.outbox.filter(item => item.partition === partition() && !deleted(item));
const pendingDeletes = () => state.deletions.filter(item => item.partition === partition() && !item.synced);
const familyDeletes = () => state.deletions.filter(item => (item.familyId || item.partition?.split('/')[1]) === state.session?.family?.id && !item.synced);
const records = () => [
  ...shared(),
  ...mine().filter(item => !shared().some(record => record.id === item.id))
].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
const memberBadge = (member, extra = '') => `<span class="avatar ${member?.id === 'family-b' ? 'avatar-peach' : ''} ${extra}" aria-hidden="true">${escape(member?.name?.slice(0, 1) || '가')}</span>`;
const title = heading => `<div class="page-intro"><h1>${heading}</h1></div>`;
const word = count => `${count}개`;

function brand() {
  return '<a class="brand" href="#timeline"><span>Still</span></a>';
}

function signal() {
  return `<span class="signal ${state.connected ? '' : 'signal-offline'}">${icon(state.connected ? 'wifi' : 'offline', 16)}${state.connected ? '온라인' : '오프라인'}</span>`;
}

function nav() {
  return `<nav aria-label="기록 공간 메뉴">${Object.keys(labels).map(page => `<a class="nav-link ${page === state.page ? 'active' : ''}" href="#${page}" ${page === state.page ? 'aria-current="page"' : ''}><span>${labels[page]}</span></a>`).join('')}</nav>`;
}

function shell() {
  const { user, family } = state.session;
  return `<div class="layout">
    <aside class="sidebar">${brand()}
      <button class="family-select" data-action="family"><span class="family-icon">${icon('people', 21)}</span><strong>${escape(family.name)}</strong>${icon('down', 15)}</button>
      ${nav()}
      <div class="sidebar-bottom"><div class="private-note">${icon('lock', 16)}<span>멤버만 공개</span></div>
      <button class="sidebar-account" data-action="account" aria-label="${escape(user.name)} 내 계정">${memberBadge(user)}<strong>${escape(user.name)}</strong>${icon('down', 15)}</button></div>
    </aside>
    <div class="workspace"><header class="topbar"><span class="desktop-current">${icon('lock', 14)} 멤버만 공개</span><div class="mobile-brand">${brand()}</div><div class="top-actions"><span id="connection">${signal()}</span><button class="mobile-account icon-button" aria-label="내 계정" data-action="account">${memberBadge(user)}</button></div></header>
    <main id="page" class="page" tabindex="-1"></main></div>
    <div class="mobile-nav">${nav()}</div>
  </div>`;
}

function render() {
  const localIds = new Set(mine().map(record => record.id));
  for (const [id, url] of localMediaUrls) {
    if (!localIds.has(id)) {
      URL.revokeObjectURL(url);
      localMediaUrls.delete(id);
    }
  }
  app.className = '';
  if (state.serviceError) {
    renderSignature = null;
    app.innerHTML = authLayout(`<h2>연결을 확인해 주세요</h2><p class="auth-description" role="alert">${escape(state.serviceError)}</p><button class="button primary full" data-action="check-connection">다시 연결</button>`);
    return;
  }
  const user = state.session?.user;
  const family = state.session?.family;
  const signature = JSON.stringify([user?.id, family?.id, state.page, user?.name, family?.name]);
  if (state.session?.recovery || !user || !family) {
    renderSignature = null;
    app.innerHTML = state.session?.recovery ? login('password-update') : user ? onboarding() : login();
    return;
  }
  if (signature !== renderSignature) {
    app.innerHTML = shell();
    renderSignature = signature;
    if (state.page === 'home') initHome(document.querySelector('#page'), { api });
  }
  document.querySelector('#connection').innerHTML = signal();
  if (state.page === 'timeline') renderTimeline();
  if (state.page === 'archive') renderArchive();
}

function authLayout(content) {
  return `<main class="login-shell">
    <section class="login-story">${brand()}<div class="login-heading"><h1>Still</h1><p>가까운 사람들과 나누는 일상</p></div><span class="story-label">비공개 기록 공간</span></section>
    <section class="login-panel"><div class="login-form-wrap">${content}</div></section>
  </main>`;
}

function login(requested = state.authPage) {
  const supported = requested === 'password-update' || requested === 'sent'
    || requested === 'signup' && state.session?.auth?.signup
    || requested === 'reset' && state.session?.auth?.recovery;
  const mode = supported ? requested : 'login';
  const notice = state.authNotice ? `<p class="auth-description" role="status">${escape(state.authNotice)}</p>` : '';
  if (mode === 'sent') return authLayout(`<h2>이메일을 확인해 주세요</h2>${notice}<button class="button primary full" data-action="auth-page" data-value="login">로그인으로 돌아가기</button>`);
  const heading = { login: '로그인', signup: '계정 만들기', reset: '비밀번호 찾기', 'password-update': '새 비밀번호' }[mode];
  const submit = { login: '로그인', signup: '계정 만들기', reset: '재설정 메일 받기', 'password-update': '비밀번호 저장' }[mode];
  const description = mode === 'signup' ? '이메일로 계정을 만들고, 함께할 공간에 참여하세요.'
    : mode === 'reset' ? '가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.'
    : mode === 'password-update' ? '앞으로 사용할 비밀번호를 입력해 주세요.' : '';
  return authLayout(`<h2>${heading}</h2>${description ? `<p class="auth-description">${description}</p>` : ''}${notice}
    <form data-form="${mode}" class="stacked auth-form">
      ${mode === 'signup' ? '<label>이름<input name="name" autocomplete="name" maxlength="48" required></label>' : ''}
      ${mode !== 'password-update' ? `<label>이메일<input name="email" type="email" autocomplete="${mode === 'signup' ? 'email' : 'username'}" value="${escape(state.authEmail)}" maxlength="254" required></label>` : ''}
      ${mode !== 'reset' ? `<label>${mode === 'password-update' ? '새 비밀번호' : '비밀번호'}<input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" ${mode !== 'login' ? 'minlength="10" aria-describedby="password-help"' : ''} maxlength="128" required></label>` : ''}
      ${['signup', 'password-update'].includes(mode) ? '<p class="field-note" id="password-help">10자 이상으로 입력해 주세요.</p><label>비밀번호 확인<input name="passwordConfirm" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label>' : ''}
      <button class="button primary" type="submit" ${!state.connected ? 'disabled' : ''}>${submit} ${icon('arrow', 17)}</button><p class="form-error" hidden role="alert"></p>
    </form>
    <div class="auth-links">${mode === 'login'
      ? `${state.session?.auth?.signup ? '<button class="text-button" data-action="auth-page" data-value="signup">계정 만들기</button>' : ''}${state.session?.auth?.recovery ? '<button class="text-button" data-action="auth-page" data-value="reset">비밀번호 찾기</button>' : ''}`
      : mode === 'password-update' ? '<button class="text-button" data-action="logout">로그아웃</button>' : '<button class="text-button" data-action="auth-page" data-value="login">로그인으로 돌아가기</button>'}</div>
    ${state.session?.demo && mode === 'login' ? `<div class="demo-users"><p>해커톤 시연 계정</p><div><button class="button outline" data-action="demo" data-value="a">서연으로 들어가기</button><button class="button outline" data-action="demo" data-value="b">지우로 들어가기</button></div></div>` : ''}
    ${!state.connected ? '<p class="auth-description" role="status">로그인하려면 인터넷 연결이 필요합니다.</p>' : ''}`);
}

function onboarding() {
  const mode = state.onboardingPage;
  return `<main class="onboarding">${brand()}<div class="panel onboarding-panel"><h1>${mode === 'create' ? '공간 만들기' : mode === 'join' ? '초대받은 공간' : '함께할 공간'}</h1><p>${escape(state.session.user.name)}님, ${mode === 'create' ? '가까운 사람들과 사용할 이름을 정해 주세요.' : mode === 'join' ? '전달받은 초대 코드를 입력해 주세요.' : '새 공간을 만들거나 초대받은 공간에 참여하세요.'}</p>
  ${mode === 'create' ? '<form class="stacked" data-form="create-family"><label>공간 이름<input name="name" maxlength="48" placeholder="우리 가족" required></label><button class="button primary" type="submit">공간 만들기</button><p class="form-error" hidden role="alert"></p></form>'
    : mode === 'join' ? '<form class="stacked" data-form="join"><label>초대 코드<input name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="80"></label><button class="button primary" type="submit">공간에 참여하기</button><p class="form-error" hidden role="alert"></p></form>'
    : '<div class="onboarding-choices"><button class="button primary" data-action="setup-page" data-value="create">새 공간 만들기</button><button class="button outline" data-action="setup-page" data-value="join">초대 코드 입력</button></div>'}
  ${mode !== 'choice' ? '<button class="text-button" data-action="setup-page" data-value="choice">뒤로</button>' : ''}
  <button class="text-button" data-action="logout">로그아웃</button></div></main>`;
}

function captureCard(kind) {
  const video = kind === 'video';
  return `<button class="capture-card easter-button ${video ? 'capture-video' : 'capture-audio'}" data-action="capture" data-value="${kind}" aria-label="${video ? '영상 기록' : '음성 기록'}">
    <span class="capture-icon">${icon(video ? 'video' : 'mic', 24)}</span>
    <span class="capture-label">${commandLabel(video ? '영상 기록' : '음성 기록', `박현준 ${video ? '영상' : '음성'} 남겨줘`)}</span>
  </button>`;
}

function calendar(all) {
  const active = dateAsNoon(state.month);
  const [year, month] = state.month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = new Set(all.map(item => dateKey(item.capturedAt)));
  const cells = Array.from({ length: firstDay }, () => '<span class="calendar-empty"></span>');
  for (let i = 1; i <= count; i++) {
    const value = state.month.slice(0, -2) + String(i).padStart(2, '0');
    cells.push(`<button class="calendar-day ${days.has(value) ? 'marked' : ''} ${state.date === value ? 'selected' : ''} ${value === dateKey(Date.now()) ? 'today' : ''}" aria-label="${dayLabel(dateAsNoon(value))}${days.has(value) ? ', 기록 있음' : ''}" aria-pressed="${state.date === value}" data-action="day" data-value="${value}">${i}</button>`);
  }
  return `<section class="panel calendar"><div class="side-title"><h2>${icon('timeline', 19)} 기록 달력</h2></div><div class="calendar-controls"><button class="icon-button" aria-label="이전 달" data-action="month" data-value="-1">${icon('left', 17)}</button><strong>${formatter({ year: 'numeric', month: 'long' }).format(active)}</strong><button class="icon-button" aria-label="다음 달" data-action="month" data-value="1">${icon('right', 17)}</button></div><div class="calendar-grid">${['일','월','화','수','목','금','토'].map(day => `<span class="weekday">${day}</span>`).join('')}${cells.join('')}</div><div class="calendar-foot"><i></i>기록이 있는 날 ${state.date ? '<button class="text-button" data-action="clear-day">전체 보기</button>' : ''}</div></section>`;
}



function recordCard(record) {
  const audio = record.kind === 'audio';
  const pending = Boolean(record.blob);
  const draft = pending && record.approved !== true;
  const action = `data-action="play" data-value="${escape(record.id)}"`;
  const stateBadge = pending ? `<span class="pending-badge">${draft ? '기기에만 저장' : '업로드 대기'}</span>` : '';
  const deleteButton = record.authorId === state.session.user.id ? `<button class="icon-button record-delete" data-action="delete" data-value="${escape(record.id)}" aria-label="${escape(record.authorName)} ${dayLabel(record.capturedAt)} ${timeLabel(record.capturedAt)} ${audio ? '음성' : '영상'} 삭제">${icon('trash', 17)}</button>` : '';
  const seconds = durationLabel(record.durationMs || (audio ? 10000 : 3000));
  if (!audio && pending && !localMediaUrls.has(record.id)) {
    localMediaUrls.set(record.id, URL.createObjectURL(record.blob));
  }
  const videoUrl = pending ? localMediaUrls.get(record.id) : record.mediaUrl;
  return `<article class="record-card ${audio ? 'audio-record' : 'video-record'}">
    <header class="record-meta"><time datetime="${escape(record.capturedAt)}">${timeLabel(record.capturedAt)}</time><strong>${escape(record.authorName)}</strong>${stateBadge}${deleteButton}</header>
    ${audio ? `<button class="audio-player" ${action} aria-label="${escape(record.authorName)} 음성 재생"><span class="audio-play">${icon('play', 20)}</span><span class="audio-caption">음성 듣기</span><span class="duration">${seconds}</span></button>
      ${!pending ? `<div class="record-footer"><details class="transcript"><summary>${record.transcript ? '텍스트 보기' : record.transcriptStatus === 'processing' ? '음성 인식 중' : '[인식 실패]'}${icon('down', 14)}</summary><p>${record.transcript ? escape(record.transcript) : record.transcriptStatus === 'processing' ? '음성을 글로 옮기는 중입니다.' : '녹음을 듣고 직접 입력할 수 있습니다.'}</p><button class="text-button" data-action="edit" data-value="${escape(record.id)}" aria-label="음성 텍스트 수정">${icon('edit', 15)} 수정</button></details><a class="icon-button" href="/api/records/${encodeURIComponent(record.id)}/audio" download aria-label="개별 M4A 내려받기">${icon('archive', 16)}</a></div>` : ''}
      ` : `<button class="video-preview" ${action} aria-label="${escape(record.authorName)} 영상 재생">${videoUrl ? `<video src="${escape(videoUrl)}#t=0.1" preload="metadata" muted playsinline aria-hidden="true" tabindex="-1"></video>` : ''}<span class="video-play">${icon('play', 22)}</span><span class="video-type">영상</span><span class="video-time">${seconds}</span></button>`}
    ${draft ? `<div class="local-actions"><button class="text-button" data-action="review-share" data-value="${escape(record.id)}">확인하고 공유하기 ${icon('arrow', 15)}</button></div>` : ''}
  </article>`;
}

function renderTimeline() {
  const page = document.querySelector('#page');
  const groups = timelineGroups(records(), state, dateKey);
  const pending = mine().filter(record => record.approved === true).length;
  const deleting = pendingDeletes().length;
  page.innerHTML = `<div class="dashboard">
    <div class="page-intro diary-intro"><div><p class="record-context">${escape(state.session.family.name)} / 비공개</p><h1>Still</h1></div><div class="diary-tools"><button class="icon-button" data-action="calendar" aria-label="날짜 선택" title="날짜 선택">${icon('timeline', 21)}</button><button class="icon-button" data-action="family" aria-label="공간 멤버" title="공간 멤버">${icon('people', 21)}</button></div></div>
    <div class="dashboard-grid"><div class="diary"><div class="capture-grid">${captureCard('video')}${captureCard('audio')}</div>
    ${!state.connected || pending || deleting ? `<div class="offline-banner" role="status"><div><strong>${[pending ? '업로드 대기 ' + word(pending) : '', deleting ? '삭제 반영 대기 ' + word(deleting) : ''].filter(Boolean).join(' · ') || '오프라인'}</strong><span>${pending || deleting ? '연결되면 반영됩니다.' : '공유를 선택한 기록은 연결 후 업로드됩니다.'}</span></div>${state.connected && (pending || deleting) ? '<button class="text-button" data-action="retry">다시 시도</button>' : ''}</div>` : ''}
    <section class="timeline" aria-label="남긴 기록"><div class="timeline-header"><div><div class="timeline-order"><select id="timeline-order" aria-label="기록 정렬"><option value="recent" ${state.order === 'recent' ? 'selected' : ''}>최근 업데이트순</option><option value="date" ${state.order === 'date' ? 'selected' : ''}>기록 날짜순</option></select>${icon('down', 14)}</div>${state.date ? `<button class="text-button selected-day" data-action="clear-day">${dayLabel(dateAsNoon(state.date))} ${icon('x', 13)}</button>` : ''}</div>
    <div class="filter" aria-label="기록 종류">${Object.entries({ all: '전체', video: '영상', audio: '음성' }).map(([key, value]) => `<button data-action="filter" data-value="${key}" aria-pressed="${key === state.filter}">${value}</button>`).join('')}</div></div>
    ${groups.length ? groups.map(({ date, records: entries }) => `<div class="timeline-day"><h3><time datetime="${date}">${date.replaceAll('-', '.')}</time><span class="day-week">${formatter({ weekday: 'long' }).format(dateAsNoon(date))}</span></h3><div class="day-records">${entries.map(recordCard).join('')}</div></div>`).join('') : '<div class="panel empty"><h3>아직 기록이 없습니다</h3><p>영상이나 음성으로 안부를 남깁니다.</p></div>'}</section></div>
    </div></div>`;
}

const within = (item, range = state.range) => {
  const day = dateKey(item.capturedAt);
  return day >= range.from && day <= range.to;
};

function archiveControls() {
  const available = shared().filter(record => within(record));
  const local = mine().filter(record => within(record) && !shared().some(saved => saved.id === record.id));
  const pending = local.filter(record => record.approved === true);
  const drafts = local.length - pending.length;
  const audio = available.filter(item => item.kind === 'audio').length;
  const video = available.length - audio;
  const hasMovie = video > 0 || (state.range.mode === 'mixed' && audio > 0);
  const types = [
    ['mp4', 'video', '영상', hasMovie],
    ['m4a', 'mic', '음성', audio > 0],
    ['txt', 'text', '텍스트', audio > 0],
    ['zip', 'box', '묶음 파일', available.length > 0]
  ];
  const commands = { mp4: '박현준 영상 묶어줘', m4a: '박현준 음성 묶어줘', txt: '박현준 글로 정리해줘', zip: '박현준 전부 담아줘' };
  const summary = `<div class="export-counts"><div><span>포함할 기록</span><strong>${word(available.length)}</strong><small>영상 ${word(video)} · 음성 ${word(audio)}</small></div><div><span>업로드 대기</span><strong>${word(pending.length)}</strong><small>이 기기 · 업로드 후 포함</small></div></div>`;
  return `${!state.connected ? '<p class="offline-banner">파일을 만들려면 인터넷 연결이 필요해요.</p>' : ''}${summary}${drafts ? `<p class="dialog-note">기기에만 저장된 ${word(drafts)}는 공유 후 포함됩니다.</p>` : ''}${familyDeletes().length ? '<p class="dialog-note">삭제 반영 후 내보낼 수 있습니다.</p>' : ''}<div class="export-grid">${types.map(([format, glyph, label, enabled]) => `<article class="panel export-card"><div class="export-icon">${icon(glyph, 23)}</div><div class="export-title"><h2>${label}</h2><span>.${format}</span></div><div class="export-actions">
    ${format === 'mp4' ? `<button class="button outline easter-button" aria-label="미리보기" data-action="preview" ${!enabled || !state.connected ? 'disabled' : ''}>${icon('play', 17)} ${commandLabel('미리보기', '박현준 먼저 보여줘')}</button>` : ''}
    <button class="button outline easter-button" aria-label="${label} 내려받기" data-action="download" data-value="${format}" ${!enabled || !state.connected ? 'disabled' : ''}>${icon('archive', 17)} ${commandLabel('내려받기', commands[format])}</button></div></article>`).join('')}</div>`;
}

function renderArchive() {
  const page = document.querySelector('#page');
  if (page.querySelector('#archive-results')) {
    if (page.querySelector('#range-error').hidden) page.querySelector('#archive-results').innerHTML = archiveControls();
    return;
  }
  page.innerHTML = `<div class="archive-page">${title('내보내기')}
    <section class="panel range-panel"><div><h2>${icon('timeline', 21)} 기간 선택</h2><div class="range-fields"><label>시작일<input type="date" name="from" value="${state.range.from}" required></label><label>종료일<input type="date" name="to" value="${state.range.to}" required></label></div><p id="range-error" class="form-error" hidden role="alert">시작일과 종료일을 순서대로 선택해 주세요.</p></div>
    <fieldset><legend>MP4 영상 구성</legend><label><input type="radio" name="mode" value="mixed" ${state.range.mode === 'mixed' ? 'checked' : ''}> 영상과 음성</label><label><input type="radio" name="mode" value="video" ${state.range.mode === 'video' ? 'checked' : ''}> 영상만</label></fieldset></section>
    <div id="archive-results">${archiveControls()}</div></div>`;
}

function discardCaptureDraft() {
  clearTimeout(capturePreviewTimer);
  captureDraft = undefined;
  if (captureDraftUrl) URL.revokeObjectURL(captureDraftUrl);
  if (previewUrl === captureDraftUrl) previewUrl = undefined;
  captureDraftUrl = undefined;
}

function modal(heading, content, className = '') {
  stopCapture?.();
  stopCapture = undefined;
  discardCaptureDraft();
  dialog.querySelector('video,audio')?.pause();
  dialog.dataset.recordId = '';
  dialog.className = className;
  dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${heading}</h2><button class="icon-button" data-action="close" aria-label="닫기">${icon('x', 21)}</button></div>${content}`;
  if (!dialog.open) dialog.showModal();
  return ++modalVersion;
}

dialog.addEventListener('close', () => {
  if (dialog.open) return;
  modalVersion++;
  stopCapture?.();
  stopCapture = undefined;
  discardCaptureDraft();
  dialog.querySelector('video,audio')?.pause();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  dialog.innerHTML = '';
});
dialog.addEventListener('click', event => { if (event.target === dialog && !savingCapture) dialog.close(); });
dialog.addEventListener('cancel', event => { if (savingCapture) event.preventDefault(); });

function familyModal() {
  const { family, user } = state.session;
  const cloudOwner = state.session.backend === 'supabase' && user.role === 'owner';
  const expiration = Date.parse(family.inviteExpiresAt);
  const expired = Number.isFinite(expiration) && expiration <= Date.now();
  modal(escape(family.name), `<p class="dialog-note">초대된 멤버만 볼 수 있습니다.</p><div class="member-list dialog-members">${family.members.map(member => `<div>${memberBadge(member)}<span>${escape(member.name)}</span>${member.id === user.id ? '<small>나</small>' : ''}</div>`).join('')}</div>
  ${family.inviteCode || cloudOwner ? `<div class="invite-box">${family.inviteCode && !expired ? `<label for="invite-code">초대 코드</label><div><input id="invite-code" readonly value="${escape(family.inviteCode)}"><button class="button outline" data-action="copy-invite">${icon('copy', 16)} 복사</button></div><small>${Number.isFinite(expiration) ? `${formatter({ month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(expiration)}까지 사용 가능합니다.` : '함께할 사람에게 코드를 전해 주세요.'}</small>` : '<p class="invite-status">사용할 수 있는 초대 코드가 없습니다.</p>'}
  ${cloudOwner ? `<div class="invite-actions"><button class="text-button" data-action="rotate-invite" ${state.connected ? '' : 'disabled'}>새 초대 코드 만들기</button></div><small>${state.connected ? '새 코드를 만들면 이전 코드는 만료됩니다.' : '연결 후 초대 코드를 만들 수 있습니다.'}</small>` : ''}</div>` : ''}<p class="form-error" role="alert" hidden></p>`);
}

function calendarModal() {
  modal('날짜 선택', calendar(records()), 'calendar-dialog');
}

function accountModal() {
  const { user, demo } = state.session;
  modal('내 계정', `<div class="dialog-profile">${memberBadge(user)}<strong>${escape(user.name)}</strong></div>
  ${demo ? `<button class="button outline full" data-action="switch">${icon('people', 19)} 다른 시연 계정으로 전환</button>` : ''}
  <button class="button outline full" data-action="logout">${icon('logout', 18)} 로그아웃</button>`);
}

function openCapture(kind) {
  const video = kind === 'video';
  const total = video ? 3 : 10;
  const owner = state.session;
  const captureVersion = modal(video ? '영상 기록' : '음성 기록', `<div class="capture-stage ${video ? 'camera-stage' : 'microphone-stage'}"><video id="live" muted playsinline hidden></video><span class="live-glyph">${icon(video ? 'video' : 'mic', 44)}</span><span class="record-counter" role="status">${video ? '촬영 준비' : '0:00'}</span></div><p class="dialog-note capture-hint">기록 후 재생해 보고 보관하거나 버리세요.</p><button class="button primary full easter-button" id="record-start" aria-label="${video ? '촬영 시작' : '녹음 시작'}">${icon(video ? 'video' : 'mic', 19)} ${commandLabel(video ? '촬영 시작' : '녹음 시작', `박현준 ${video ? '촬영' : '녹음'} 시작해줘`)}</button><button class="button primary full easter-button" id="record-stop" aria-label="녹음 끝내기" hidden>${icon('stop', 17)} ${commandLabel('녹음 끝내기', '박현준 녹음 끝내줘')}</button>`, 'capture-dialog');
  const start = dialog.querySelector('#record-start');
  const stop = dialog.querySelector('#record-stop');
  start.addEventListener('click', async () => {
    start.disabled = true;
    const stage = dialog.querySelector('.capture-stage');
    const counter = dialog.querySelector('.record-counter');
    const hint = dialog.querySelector('.capture-hint');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      hint.textContent = '이 브라우저에서 카메라·마이크를 사용할 수 없어요. HTTPS 또는 localhost에서 다시 열어 주세요.';
      return;
    }
    let stream;
    let timeout;
    let interval;
    let recorder;
    let startedAt;
    let recordedMs;
    let cancelled = false;
    const release = () => {
      clearTimeout(timeout);
      clearInterval(interval);
      stop.onclick = null;
      stream?.getTracks().forEach(track => track.stop());
    };
    stopCapture = () => {
      cancelled = true;
      if (recorder?.state === 'recording') recorder.stop();
      release();
    };
    const showError = message => {
      if (cancelled || !dialog.open || modalVersion !== captureVersion) return;
      hint.textContent = message;
      stage.classList.remove('recording');
      start.innerHTML = commandLabel(video ? '촬영 시작' : '녹음 시작', `박현준 ${video ? '촬영' : '녹음'} 시작해줘`);
      start.hidden = false;
      start.disabled = false;
      stop.hidden = true;
    };
    try {
      const settings = video ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 }, facingMode: { ideal: 'environment' } } : false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: settings, audio: true });
      } catch (error) {
        if (!video || error.name !== 'NotFoundError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({ video: settings, audio: false });
      }
      if (cancelled || !dialog.open || modalVersion !== captureVersion) { release(); return; }
      if (video) {
        const live = dialog.querySelector('#live');
        live.srcObject = stream;
        live.hidden = false;
        live.play().catch(() => {});
      }
      const types = video ? ['video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm'] : ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];
      const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), ...(video ? { videoBitsPerSecond: 720000 } : { audioBitsPerSecond: 48000 }) });
      const parts = [];
      const capturedAt = new Date().toISOString();
      let failed = false;
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      recorder.onerror = () => {
        failed = true;
        release();
        showError('기록에 실패했습니다. 다시 시도해 주세요.');
      };
      recorder.onstop = () => {
        recordedMs ??= Math.round(performance.now() - startedAt);
        release();
        if (cancelled || failed || !dialog.open || modalVersion !== captureVersion) return;
        stopCapture = undefined;
        try {
          if (!parts.length) throw new Error('empty recording');
          const blob = new Blob(parts, { type: recorder.mimeType || parts[0].type || mimeType });
          if (!blob.size || recordedMs < 100) throw new Error('recording too short');
          const record = {
            id: crypto.randomUUID(), partition: partition(owner), kind, capturedAt,
            familyId: owner.family.id, approved: false,
            durationMs: Math.min(total * 1000, recordedMs), authorId: owner.user.id, authorName: owner.user.name, blob
          };
          if (partition() === record.partition) reviewCapture(record);
        } catch {
          showError('기록이 너무 짧거나 비어 있습니다. 다시 시도해 주세요.');
        }
      };
      recorder.start();
      startedAt = performance.now();
      const finish = () => {
        if (recorder.state !== 'recording') return;
        recordedMs = Math.round(performance.now() - startedAt);
        clearTimeout(timeout);
        clearInterval(interval);
        stop.disabled = true;
        hint.textContent = '미리보기 준비 중…';
        recorder.stop();
      };
      stage.classList.add('recording');
      hint.textContent = video ? '촬영 중' : '녹음 중';
      start.textContent = '기록 중…';
      if (!video) { start.hidden = true; stop.hidden = false; stop.disabled = false; stop.onclick = finish; }
      interval = setInterval(() => {
        const elapsed = performance.now() - startedAt;
        counter.textContent = video ? Math.max(1, Math.ceil((total * 1000 - elapsed) / 1000)) + '초' : `0:${String(Math.min(10, Math.floor(elapsed / 1000))).padStart(2, '0')}`;
      }, 120);
      timeout = setTimeout(finish, total * 1000);
    } catch {
      release();
      showError('카메라나 마이크를 열 수 없습니다. 브라우저 권한과 기기 연결을 확인해 주세요.');
    }
  });
}

function reviewCapture(record) {
  const video = record.kind === 'video';
  const url = URL.createObjectURL(record.blob);
  const version = modal(video ? '촬영 확인' : '녹음 확인', `<${video ? 'video' : 'audio'} class="dialog-media" controls playsinline preload="auto" src="${url}"></${video ? 'video' : 'audio'}>
    <p class="dialog-note">${(record.durationMs / 1000).toFixed(1).replace(/\.0$/, '')}초 · 아직 저장하지 않았습니다. 닫으면 버려집니다.</p>
    <div class="dialog-actions"><button class="button outline" data-action="keep-capture" disabled>기기에 보관</button><button class="button primary" data-action="share-capture" disabled>공간에 공유</button></div>
    <div class="capture-review-actions"><button class="text-button easter-button" aria-label="${video ? '다시 촬영' : '다시 녹음'}" data-action="retake-capture">${commandLabel(video ? '다시 촬영' : '다시 녹음', `박현준 ${video ? '다시 찍어줘' : '다시 녹음해줘'}`)}</button><button class="text-button discard-button" data-action="discard-capture">버리기</button></div>
    <p class="form-error" role="alert" hidden></p>`, 'capture-review');
  captureDraft = record;
  captureDraftUrl = url;
  previewUrl = url;
  const player = dialog.querySelector(video ? 'video' : 'audio');
  const checkPreview = playable => {
    if (!dialog.open || modalVersion !== version) return;
    clearTimeout(capturePreviewTimer);
    for (const button of dialog.querySelectorAll('[data-action="keep-capture"],[data-action="share-capture"]')) button.disabled = !playable;
    captureDraft.playable = playable;
    const note = dialog.querySelector('.form-error');
    note.hidden = playable;
    if (!playable) note.textContent = '기록을 재생할 수 없습니다. 다시 기록해 주세요.';
  };
  player.addEventListener('canplay', () => checkPreview(true), { once: true });
  player.addEventListener('error', () => checkPreview(false), { once: true });
  capturePreviewTimer = setTimeout(() => checkPreview(false), 8000);
  if (player.readyState >= 3) checkPreview(true);
}

async function keepCapture(approved) {
  if (savingCapture || !captureDraft?.playable || captureDraft.partition !== partition()) return;
  const record = captureDraft;
  const version = modalVersion;
  savingCapture = true;
  for (const button of dialog.querySelectorAll('button')) button.disabled = true;
  try {
    if (!await savePending({ ...record, approved })) throw new Error('record deleted');
    await readLocal();
    announceLocalChange();
    savingCapture = false;
    if (dialog.open && modalVersion === version) dialog.close();
    render();
    if (record.partition !== partition()) return;
    notify(approved ? (state.connected ? '공유를 준비하고 있습니다.' : '연결되면 공간에 공유됩니다.') : '이 기기에 보관했습니다.');
    if (approved) sync();
  } catch {
    if (dialog.open && modalVersion === version) {
      const note = dialog.querySelector('.form-error');
      note.hidden = false;
      note.textContent = '저장하지 못했습니다. 저장 공간을 확인하고 다시 시도해 주세요.';
    }
  } finally {
    savingCapture = false;
    if (modalVersion === version) for (const button of dialog.querySelectorAll('button')) button.disabled = false;
  }
}

function play(record) {
  if (record && deleted(record)) return;
  if (!record || (!record.blob && !state.connected)) {
    notify('이 기록을 재생하려면 연결이 필요해요.', true);
    return;
  }
  const tag = record.kind === 'audio' ? 'audio' : 'video';
  if (record.blob) previewUrl = URL.createObjectURL(record.blob);
  modal(`${escape(record.authorName)}님의 ${tag === 'video' ? '영상' : '음성'}`,
    `<p class="dialog-note">${dayLabel(record.capturedAt)} · ${timeLabel(record.capturedAt)}</p><${tag} class="dialog-media" controls playsinline autoplay src="${escape(previewUrl || record.mediaUrl)}"></${tag}>`, 'media-dialog');
  dialog.dataset.recordId = record.id;
}

function edit(record) {
  if (!record || deleted(record)) return;
  modal('음성 텍스트 수정', `<p class="dialog-note">${escape(record.authorName)} · ${dayLabel(record.capturedAt)} · ${timeLabel(record.capturedAt)}</p>
  <audio class="dialog-media" controls preload="none" src="${escape(record.mediaUrl)}"></audio><form data-form="edit" data-id="${escape(record.id)}" class="stacked"><label>음성 텍스트<textarea name="transcript" rows="4" required maxlength="5000">${escape(record.transcript)}</textarea></label><button class="button primary">수정 저장</button><p class="form-error" hidden role="alert"></p></form>`);
  dialog.dataset.recordId = record.id;
}

function reviewShare(record) {
  if (!record?.blob || record.partition !== partition() || deleted(record)) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(record.blob);
  const tag = record.kind === 'video' ? 'video' : 'audio';
  modal('이 공간에 공유할까요?', `<${tag} class="dialog-media" controls playsinline src="${previewUrl}"></${tag}>
    <p class="dialog-note">아직 이 기기에만 저장되어 있습니다.${state.connected ? '' : ' 공유를 선택하면 연결될 때 업로드됩니다.'}</p>
    <div class="dialog-actions"><button class="button outline" data-action="close">기기에 보관</button><button class="button primary" data-action="approve-share" data-value="${escape(record.id)}">공간에 공유</button></div><p class="form-error" role="alert" hidden></p>`, 'share-dialog');
  dialog.dataset.recordId = record.id;
}

async function shareRecord(id, button) {
  const key = partition();
  button.disabled = true;
  try {
    if (!await approvePending(id, key)) throw new Error('record no longer available');
    await readLocal();
    announceLocalChange();
    if (dialog.open && dialog.dataset.recordId === id) dialog.close();
    render();
    notify(state.connected ? '공유를 준비하고 있습니다.' : '연결되면 공간에 공유됩니다.');
    await sync();
  } catch (error) {
    const note = dialog.querySelector('.form-error');
    if (note) { note.hidden = false; note.textContent = '공유 상태를 저장하지 못했습니다. 다시 시도해 주세요.'; }
  } finally { button.disabled = false; }
}

function confirmDeletion(record) {
  if (!record || record.authorId !== state.session.user.id || deleted(record)) return;
  const localOnly = record.blob && record.approved !== true;
  modal('이 기록을 삭제할까요?', `<p class="dialog-note">${dayLabel(record.capturedAt)} · ${timeLabel(record.capturedAt)} · ${record.kind === 'video' ? '영상' : '음성'}</p>
    <p class="delete-description">${localOnly ? '이 기기에서 삭제됩니다.' : state.connected ? '기록 공간에서도 삭제됩니다.' : '이 기기에서 먼저 지우고, 연결되면 기록 공간에서도 삭제됩니다.'} 삭제한 기록은 되돌릴 수 없습니다.</p>
    <div class="dialog-actions"><button class="button outline" data-action="close">취소</button><button class="button danger" data-action="confirm-delete" data-value="${escape(record.id)}">삭제</button></div><p class="form-error" role="alert" hidden></p>`, 'delete-dialog');
  dialog.dataset.recordId = record.id;
}

async function deleteRecord(id, button) {
  const record = records().find(item => item.id === id);
  if (!record || record.authorId !== state.session.user.id) return;
  button.disabled = true;
  try {
    await queueDeletion({ ...record, partition: partition(), familyId: state.session.family.id });
    await readLocal();
    state.records = shared();
    announceLocalChange();
    if (dialog.open && dialog.dataset.recordId === id) dialog.close();
    render();
    notify('기기에서 삭제했습니다.');
    await sync();
  } catch (error) {
    const note = dialog.querySelector('.form-error');
    if (note) { note.hidden = false; note.textContent = '삭제하지 못했습니다. 다시 시도해 주세요.'; }
  } finally { button.disabled = false; }
}

async function exportFile(format, preview = false) {
  const key = partition();
  const sessionAtExport = sessionVersion;
  const params = new URLSearchParams({ ...state.range, format, tz: zone });
  const version = preview ? modal('내보낸 영상 미리보기', '<p class="dialog-note" role="status">서버에서 영상을 이어 붙이는 중…</p>', 'media-dialog') : null;
  if (!preview) notify('서버에서 파일을 만드는 중이에요.');
  const isCurrent = () => sessionAtExport === sessionVersion && partition() === key && (!preview || (dialog.open && modalVersion === version));
  try {
    await sync();
    await readLocal();
    if (!isCurrent()) return;
    if (familyDeletes().length) throw new Error('deletions pending');
    const response = await fetch('/api/export?' + params, { cache: 'no-store' });
    if (!isCurrent()) return;
    if (!response.ok) {
      if ([401, 403].includes(response.status)) await clearAccess();
      throw new Error();
    }
    const blob = await response.blob();
    if (!isCurrent()) return;
    if (preview) {
      previewUrl = URL.createObjectURL(blob);
      modal('내보낸 영상 미리보기', `<video class="dialog-media" controls playsinline src="${previewUrl}"></video>`, 'media-dialog');
    } else {
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `Still_${params.get('from')}_${params.get('to')}.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 30000);
      notify('파일을 준비했어요.');
    }
  } catch {
    if (!isCurrent()) return;
    if (preview && dialog.open) dialog.close();
    notify(familyDeletes().length ? '삭제한 기록의 작성자 계정에서 연결한 뒤 다시 시도해 주세요.' : '파일을 만들지 못했어요. 연결과 선택한 기간을 확인해 주세요.', true);
  }
}

async function useSession(session) {
  const version = ++sessionVersion;
  const previous = partition();
  const changed = partition(session) !== previous || session?.recovery || state.session?.recovery
    || state.session?.user?.role !== session?.user?.role;
  if (changed) {
    state.records = [];
    stopCapture?.();
    discardCaptureDraft();
    if (dialog.open) dialog.close();
  }
  state.session = session;
  state.serviceError = '';
  state.connected = true;
  if (changed) render();
  const previousCache = previous || partition(await readDevice('session').catch(() => null));
  if (version !== sessionVersion) return;
  if (previousCache && (previousCache !== partition(session) || session?.recovery)) await writeDevice('records:' + previousCache, []).catch(() => {});
  if (version !== sessionVersion) return;
  await readLocal().catch(() => {});
  if (version !== sessionVersion) return;
  await writeDevice('session', offlineSession(session)).catch(() => {});
  if (version !== sessionVersion) return;
  if (partition() && !session?.recovery) await loadRecords();
  if (version !== sessionVersion) return;
  render();
  if (!session?.recovery) sync();
}

async function clearAccess(broadcast = true, renderNow = true) {
  const version = ++sessionVersion;
  const previous = partition();
  state.records = [];
  state.session = anonymousSession(state.session);
  state.authPage = 'login';
  state.authNotice = '';
  state.onboardingPage = 'choice';
  state.serviceError = '';
  stopCapture?.();
  discardCaptureDraft();
  if (dialog.open) dialog.close();
  if (renderNow) render();
  if (broadcast) localChannel?.postMessage({ type: 'signed-out' });
  const previousCache = previous || partition(await readDevice('session').catch(() => null));
  if (version !== sessionVersion) return;
  await Promise.allSettled([
    writeDevice('session', null),
    ...(previousCache ? [writeDevice('records:' + previousCache, [])] : [])
  ]);
}

async function loadRecords() {
  const key = partition();
  const version = sessionVersion;
  if (!key) return;
  try {
    const { records } = await api('/api/records');
    if (partition() !== key || version !== sessionVersion) return;
    await readLocal();
    if (partition() !== key || version !== sessionVersion) return;
    state.records = records.filter(record => !deleted(record));
    state.connected = true;
    state.serviceError = '';
    await writeDevice('records:' + key, state.records).catch(() => {});
  } catch (error) {
    if (partition() !== key || version !== sessionVersion) return;
    if (error.status === 401 || error.status === 403) {
      await clearAccess();
    } else if (isNetworkFailure(error)) {
      state.connected = false;
      const cached = await readDevice('records:' + key).catch(() => []);
      if (partition() !== key || version !== sessionVersion) return;
      state.records = (cached || state.records).filter(record => !deleted(record));
    } else {
      state.records = [];
      state.serviceError = error.message;
    }
  }
}

const localChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('our-days-records') : null;
const announceLocalChange = () => localChannel?.postMessage('changed');
localChannel?.addEventListener('message', event => {
  if (event.data?.type === 'signed-out') clearAccess(false);
  else refresh();
});

async function readLocal() {
  const before = JSON.stringify([state.outbox.map(({id, approved}) => [id, approved]), state.deletions]);
  [state.outbox, state.deletions] = await Promise.all([readOutbox(), readDeletions()]);
  if (dialog.open && dialog.dataset.recordId && deleted({ id: dialog.dataset.recordId })) dialog.close();
  return before !== JSON.stringify([state.outbox.map(({id, approved}) => [id, approved]), state.deletions]);
}

function sync() {
  if (syncTask) return syncTask;
  const key = partition();
  const version = sessionVersion;
  const isCurrent = () => partition() === key && version === sessionVersion;
  if (!key || !navigator.onLine || state.session?.recovery || state.serviceError) return Promise.resolve();
  syncTask = (async () => {
    syncing = true;
    let shouldRender = false;
    try {
      shouldRender = await readLocal();
      if (!isCurrent()) return;
      if (!pendingDeletes().length && !mine().some(record => record.approved === true && !notifiedUploads.has(record.id))) return;
      shouldRender = true;
      const result = await syncRecords({
        partition: key, authorId: state.session.user.id, familyId: state.session.family.id,
        store: device, api, isCurrent, skipIds: notifiedUploads,
        onRejected(record) {
          if (!isCurrent()) return;
          notifiedUploads.add(record.id);
          notify('파일을 읽지 못했습니다. 기기에 보관 중이니 다시 시도하거나 삭제해 주세요.', true);
        },
        async onUploaded(record) {
          await readLocal();
          if (!isCurrent() || deleted(record)) return;
          state.records = [...shared().filter(item => item.id !== record.id), record];
          await writeDevice('records:' + key, state.records).catch(() => {});
        }
      });
      if (!isCurrent()) return;
      if (result.uploaded) notify(`기록 ${word(result.uploaded)}를 공간에 공유했습니다.`);
      else if (result.deleted) notify('삭제를 반영했습니다.');
      if (result.uploaded || result.deleted) announceLocalChange();
    } catch (error) {
      if (isCurrent()) {
        if (isNetworkFailure(error)) state.connected = false;
        else notify(error.message, true);
      }
    } finally {
      shouldRender = await readLocal().catch(() => false) || shouldRender;
      state.records = shared();
      syncing = false;
      if (shouldRender) render();
    }
  })().finally(() => { syncTask = undefined; });
  return syncTask;
}

async function refresh() {
  if (refreshing || !partition() || state.session?.recovery) return;
  refreshing = true;
  const before = JSON.stringify(state.records);
  const connected = state.connected;
  const serviceError = state.serviceError;
  const version = sessionVersion;
  try {
    const localChanged = await readLocal();
    if (localChanged) { state.records = shared(); render(); }
    if (syncing || !navigator.onLine) return;
    const session = await api('/api/session');
    if (version !== sessionVersion) return;
    if (JSON.stringify(session) !== JSON.stringify(state.session)) {
      await useSession(session);
      return;
    }
    await loadRecords();
    if (before !== JSON.stringify(state.records) || connected !== state.connected || serviceError !== state.serviceError) render();
  } catch (error) {
    if (version !== sessionVersion) return;
    if (isNetworkFailure(error)) state.connected = false;
    else if (![401, 403].includes(error.status)) state.serviceError = error.message;
    render();
  } finally {
    refreshing = false;
  }
  sync();
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, value } = button.dataset;
  switch (action) {
    case 'auth-page': {
      state.authEmail = app.querySelector('[name="email"]')?.value || state.authEmail;
      state.authPage = ['login', 'signup', 'reset'].includes(value) ? value : 'login';
      state.authNotice = '';
      render();
      app.querySelector('input')?.focus();
      break;
    }
    case 'setup-page': state.onboardingPage = ['create', 'join'].includes(value) ? value : 'choice'; render(); app.querySelector('input')?.focus(); break;
    case 'check-connection': button.disabled = true; await start(); break;
    case 'capture': openCapture(value); break;
    case 'filter': state.filter = value; renderTimeline(); break;
    case 'month': {
      const [year, month] = state.month.split('-').map(Number);
      state.month = startOfMonth(dateKey(new Date(Date.UTC(year, month - 1 + Number(value), 1))));
      if (dialog.open && dialog.classList.contains('calendar-dialog')) {
        calendarModal();
        dialog.querySelector(`[data-action="month"][data-value="${value}"]`)?.focus();
      } else renderTimeline();
      break;
    }
    case 'day': state.date = state.date === value ? '' : value; if (dialog.open) dialog.close(); renderTimeline(); break;
    case 'clear-day': state.date = ''; if (dialog.open) dialog.close(); renderTimeline(); break;
    case 'calendar': calendarModal(); break;
    case 'family': familyModal(); break;
    case 'account': accountModal(); break;
    case 'close': if (!savingCapture) dialog.close(); break;
    case 'keep-capture': await keepCapture(false); break;
    case 'share-capture': await keepCapture(true); break;
    case 'discard-capture': if (!savingCapture) dialog.close(); break;
    case 'retake-capture': {
      if (!savingCapture && captureDraft) openCapture(captureDraft.kind);
      break;
    }
    case 'play': play(records().find(record => record.id === value)); break;
    case 'edit': edit(state.records.find(record => record.id === value)); break;
    case 'review-share': reviewShare(mine().find(record => record.id === value)); break;
    case 'approve-share': await shareRecord(value, button); break;
    case 'delete': confirmDeletion(records().find(record => record.id === value)); break;
    case 'confirm-delete': await deleteRecord(value, button); break;
    case 'preview': exportFile('mp4', true); break;
    case 'download': exportFile(value); break;
    case 'retry': notifiedUploads.clear(); sync(); break;
    case 'copy-invite': {
      const code = dialog.querySelector('#invite-code');
      try { await navigator.clipboard.writeText(code.value); notify('초대 코드를 복사했어요.'); }
      catch { code.select(); notify('선택한 초대 코드를 복사해 주세요.'); }
      break;
    }
    case 'rotate-invite': {
      const version = sessionVersion;
      button.disabled = true;
      try {
        const session = await api('/api/invite/rotate', { method: 'POST' });
        if (version !== sessionVersion) return;
        await useSession(session);
        if (state.session?.family) familyModal();
        notify('새 초대 코드를 만들었습니다.');
      } catch (failure) {
        if (version !== sessionVersion) return;
        const note = dialog.querySelector('.form-error');
        if (note) { note.textContent = failure.message; note.hidden = false; }
      } finally { button.disabled = false; }
      break;
    }
    case 'switch':
    case 'logout': {
      const version = sessionVersion;
      try {
        await api('/api/logout', { method: 'POST' });
        if (version !== sessionVersion) return;
        state.filter = 'all';
        state.order = 'recent';
        state.date = '';
        await clearAccess();
      } catch (failure) {
        if (version !== sessionVersion) return;
        if (failure.code === 'LOGOUT_REVOKE_FAILED') await clearAccess();
        if (failure.status !== 401) notify(isNetworkFailure(failure) ? '로그아웃하려면 연결이 필요해요.' : failure.message, true);
      }
      break;
    }
    case 'demo': {
      const form = app.querySelector('[data-form="login"]');
      form.elements.email.value = demoUsers[value].email;
      form.elements.password.value = 'demo2026!';
      form.requestSubmit();
      break;
    }
  }
});

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(form));
  const submit = form.querySelector('button[type="submit"],button');
  const error = form.querySelector('.form-error');
  const version = sessionVersion;
  error.hidden = true;
  submit.disabled = true;
  try {
    const action = form.dataset.form;
    const validation = validateAuthFields(action, fields);
    if (validation) {
      error.textContent = validation;
      error.hidden = false;
      return;
    }
    if (action === 'edit') {
      const { record } = await api('/api/records/' + encodeURIComponent(form.dataset.id), { method: 'PATCH', json: fields });
      if (version !== sessionVersion) return;
      state.records = state.records.map(item => item.id === record.id ? record : item);
      await writeDevice('records:' + partition(), state.records).catch(() => {});
      if (version !== sessionVersion) return;
      dialog.close();
      render();
      notify('텍스트를 수정했어요.');
      return;
    }
    const path = { login: '/api/login', signup: '/api/signup', reset: '/api/password/reset', 'password-update': '/api/password/update', 'create-family': '/api/family', join: '/api/invite/accept' }[action];
    if (!path) return;
    const { passwordConfirm, ...payload } = fields;
    const result = await api(path, { method: 'POST', json: payload });
    if (version !== sessionVersion) return;
    state.authEmail = fields.email || state.authEmail;
    if (action === 'reset' || result?.confirmationRequired) {
      state.authPage = 'sent';
      state.authNotice = action === 'reset' ? '가입된 이메일이라면 재설정 링크를 보냈습니다. 메일이 보이지 않으면 스팸함도 확인해 주세요.'
        : '확인 메일을 보냈습니다. 이메일의 링크를 연 뒤 로그인해 주세요.';
      form.reset();
      render();
      return;
    }
    state.authPage = 'login';
    state.authNotice = '';
    const session = result?.user !== undefined ? result : await api('/api/session');
    if (version !== sessionVersion) return;
    await useSession(session);
    if (action === 'password-update') notify('비밀번호를 변경했습니다.');
  } catch (failure) {
    if (version !== sessionVersion) return;
    error.textContent = isNetworkFailure(failure) ? '인터넷 연결을 확인해 주세요.' :
      form.dataset.form === 'login' && failure.status === 401 ? '이메일과 비밀번호를 확인해 주세요.' : failure.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'timeline-order') {
    state.order = event.target.value === 'date' ? 'date' : 'recent';
    renderTimeline();
    document.querySelector('#timeline-order')?.focus({ preventScroll: true });
    return;
  }
  if (!event.target.closest('.range-panel')) return;
  const page = document.querySelector('#page');
  const from = page.querySelector('[name="from"]').value;
  const to = page.querySelector('[name="to"]').value;
  const invalid = !from || !to || from > to;
  page.querySelector('#range-error').hidden = !invalid;
  if (invalid) {
    page.querySelector('#archive-results').innerHTML = '';
    return;
  }
  state.range = { from, to, mode: page.querySelector('[name="mode"]:checked').value };
  renderArchive();
});

function setPage() {
  const requested = location.hash.slice(1);
  state.page = Object.hasOwn(labels, requested) ? requested : 'timeline';
}

window.addEventListener('hashchange', () => {
  setPage();
  render();
  document.querySelector('#page')?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
window.addEventListener('offline', () => { state.connected = false; render(); });
window.addEventListener('online', () => { partition() ? refresh() : start(); });
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 3500);

async function start() {
  if (starting) return starting;
  starting = (async () => {
  const version = sessionVersion;
  setPage();
  const query = new URLSearchParams(location.search);
  if (query.has('auth_error')) {
    state.authNotice = '링크가 만료되었거나 이미 사용되었습니다. 새 메일을 요청해 주세요.';
    query.delete('auth_error');
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query : '') + location.hash);
  }
  await readLocal().catch(() => {});
  if (version !== sessionVersion) return;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    const session = await api('/api/session');
    if (version !== sessionVersion) return;
    await useSession(session);
  } catch (error) {
    if (version !== sessionVersion) return;
    if (isNetworkFailure(error)) {
      state.connected = false;
      state.serviceError = '';
      const cachedSession = offlineSession(await readDevice('session').catch(() => null));
      const cachedRecords = partition(cachedSession) ? await readDevice('records:' + partition(cachedSession)).catch(() => []) || [] : [];
      if (version !== sessionVersion) return;
      state.session = cachedSession;
      state.records = cachedRecords;
    } else {
      await clearAccess(false, false);
      state.serviceError = [401, 403].includes(error.status) ? '' : error.message;
    }
    render();
  }
  })().finally(() => { starting = undefined; });
  return starting;
}

start();

