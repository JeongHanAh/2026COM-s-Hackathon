import { icon } from './icons.js';
import * as device from './device.js';
import { readDevice, writeDevice, readOutbox, savePending, readDeletions, queueDeletion, approvePending } from './device.js';
import { syncRecords } from './record-sync.js';
import { initHome } from './home.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#notice');
const zone = 'Asia/Seoul';
const formatter = options => new Intl.DateTimeFormat('ko-KR', { timeZone: zone, ...options });
const dateKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const dateKey = value => dateKeyFormat.format(new Date(value));
const dayLabel = value => formatter({ month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(value));
const timeLabel = value => formatter({ hour: 'numeric', minute: '2-digit' }).format(new Date(value));
const startOfMonth = date => date.slice(0, 7) + '-01';
const dateAsNoon = date => new Date(date + 'T12:00:00+09:00');
const labels = { timeline: '일상 기록', archive: '내보내기', home: '우리 집 주변' };
const demoUsers = { a: { name: '서연', email: 'family-a@example.test' }, b: { name: '지우', email: 'family-b@example.test' } };
const state = {
  session: null, records: [], outbox: [], deletions: [], connected: navigator.onLine,
  page: 'timeline', date: '', month: startOfMonth(dateKey(Date.now())), filter: 'all',
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
  const response = await fetch(path, {
    cache: 'no-store', credentials: 'same-origin',
    signal: AbortSignal.timeout(path === '/api/records' && request.method === 'POST' ? 45000 : 8000),
    ...request,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json', ...request.headers } } : {})
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = typeof payload.error === 'string' && /[가-힣]/.test(payload.error) ? payload.error : {
      400: '입력값을 확인해 주세요.', 401: '다시 로그인해 주세요.', 403: '이 작업을 할 권한이 없습니다.',
      404: '선택한 기록을 찾을 수 없습니다.', 409: '다른 가족 계정으로 연결되어 있습니다.',
      422: '파일을 처리할 수 없습니다.', 429: '잠시 뒤 다시 시도해 주세요.', 503: '서버에서 파일을 만들 수 없습니다.'
    }[response.status];
    throw Object.assign(new Error(message || '요청을 처리하지 못했습니다.'), { status: response.status, code: payload.code });
  }
  return response.status === 204 ? null : response.json();
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
  return '<a class="brand" href="#timeline"><img src="/icon.svg" alt="" width="38" height="38"><span>우리의 일상 기록</span></a>';
}

function signal() {
  return `<span class="signal ${state.connected ? '' : 'signal-offline'}">${icon(state.connected ? 'wifi' : 'offline', 16)}${state.connected ? '온라인' : '오프라인'}</span>`;
}

function nav() {
  return `<nav aria-label="가족 공간 메뉴">${Object.keys(labels).map(page => `<a class="nav-link ${page === state.page ? 'active' : ''}" href="#${page}" ${page === state.page ? 'aria-current="page"' : ''}>${icon(page, 20)}<span>${labels[page]}</span></a>`).join('')}</nav>`;
}

function shell() {
  const { user, family } = state.session;
  return `<div class="layout">
    <aside class="sidebar">${brand()}
      <button class="family-select" data-action="family"><span class="family-icon">${icon('people', 21)}</span><strong>${escape(family.name)}</strong>${icon('down', 15)}</button>
      ${nav()}
      <div class="sidebar-bottom"><div class="private-note">${icon('lock', 16)}<span>가족만 공개</span></div>
      <button class="sidebar-account" data-action="account" aria-label="${escape(user.name)} 내 계정">${memberBadge(user)}<strong>${escape(user.name)}</strong>${icon('down', 15)}</button></div>
    </aside>
    <div class="workspace"><header class="topbar"><span class="desktop-current">${icon('lock', 14)} 가족만 공개</span><div class="mobile-brand">${brand()}</div><div class="top-actions"><span id="connection">${signal()}</span><button class="mobile-account icon-button" aria-label="내 계정" data-action="account">${memberBadge(user)}</button></div></header>
    <main id="page" class="page" tabindex="-1"></main></div>
    <div class="mobile-nav">${nav()}</div>
  </div>`;
}

function render() {
  const localIds = new Set(mine().map(record => record.id));
  for (const [id, url] of localMediaUrls) {
    if (!localIds.has(id)) { URL.revokeObjectURL(url); localMediaUrls.delete(id); }
  }
  app.className = '';
  const user = state.session?.user;
  const family = state.session?.family;
  const signature = JSON.stringify([user?.id, family?.id, state.page, user?.name, family?.name]);
  if (!user || !family) {
    renderSignature = null;
    app.innerHTML = user ? onboarding() : login();
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

function login() {
  return `<main class="login-shell">
    <section class="login-story">${brand()}<div class="login-heading"><h1>우리의<br>일상 기록.</h1><p>3초 영상. 최대 10초 음성.</p></div><span class="story-label">${icon('lock', 17)} 가족만 공개</span></section>
    <section class="login-panel"><div class="login-form-wrap"><h2>가족 공간 로그인</h2><form data-form="login" class="stacked">
      <label>이메일<input name="email" type="email" autocomplete="username" required placeholder="이메일 주소"></label>
      <label>비밀번호<input name="password" type="password" autocomplete="current-password" required placeholder="비밀번호"></label>
      <button class="button primary" type="submit">로그인 ${icon('arrow', 17)}</button>
      <p class="form-error" hidden role="alert"></p></form>
      ${state.session?.demo ? `<div class="demo-users"><p>해커톤 시연 계정</p><div><button class="button outline" data-action="demo" data-value="a">서연으로 들어가기</button><button class="button outline" data-action="demo" data-value="b">지우로 들어가기</button></div></div>` : ''}
      ${state.connected ? '' : '<p class="muted">처음 로그인하려면 인터넷 연결이 필요해요.</p>'}
    </div></section>
  </main>`;
}

function onboarding() {
  return `<main class="onboarding">${brand()}<div class="panel onboarding-panel"><h1>가족 공간에 참여하기</h1><p>${escape(state.session.user.name)}님, 가족 공간을 만들거나 초대 코드를 입력해 주세요.</p>
  <form class="stacked" data-form="create-family"><label>가족 공간 이름<input name="name" maxlength="48" value="우리 가족" required></label><button class="button primary">가족 공간 만들기</button><p class="form-error" hidden role="alert"></p></form>
  <form class="stacked" data-form="join"><label>가족에게 받은 초대 코드<input name="code" required autocomplete="off" maxlength="80"></label><button class="button outline">초대 코드로 참여하기</button><p class="form-error" hidden role="alert"></p></form>
  <button class="text-button" data-action="logout">로그아웃</button></div></main>`;
}

function captureCard(kind) {
  const video = kind === 'video';
  return `<button class="capture-card ${video ? 'capture-video' : 'capture-audio'}" data-action="capture" data-value="${kind}" aria-label="${video ? '3초 영상 남기기' : '최대 10초 음성 남기기'}">
    <span class="capture-icon">${icon(video ? 'video' : 'mic', 20)}</span><span class="capture-label">${video ? '영상' : '음성'}</span><span class="capture-duration">${video ? '3초' : '최대 10초'}</span>
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
  if (!audio && pending && !localMediaUrls.has(record.id)) localMediaUrls.set(record.id, URL.createObjectURL(record.blob));
  const videoUrl = pending ? localMediaUrls.get(record.id) : record.mediaUrl;
  return `<article class="record-card ${audio ? 'audio-record' : 'video-record'}">
    <header class="record-meta">${memberBadge({ id: record.authorId, name: record.authorName })}<div><strong>${escape(record.authorName)}</strong><span>${timeLabel(record.capturedAt)}</span></div>${stateBadge}${deleteButton}</header>
    ${audio ? `<button class="audio-player" ${action} aria-label="${escape(record.authorName)} 음성 재생"><span class="audio-play">${icon('play', 20)}</span><span class="audio-caption">음성 듣기</span><span class="duration">${seconds}</span></button>
      ${!pending ? `<div class="record-footer"><details class="transcript"><summary>${record.transcript ? '텍스트 보기' : record.transcriptStatus === 'processing' ? '음성 인식 중' : '[인식 실패]'}${icon('down', 14)}</summary><p>${record.transcript ? escape(record.transcript) : record.transcriptStatus === 'processing' ? '음성을 글로 옮기고 있어요.' : '녹음을 듣고 텍스트를 입력할 수 있어요.'}</p><button class="text-button" data-action="edit" data-value="${escape(record.id)}" aria-label="음성 텍스트 수정">${icon('edit', 15)} 수정</button></details><a class="icon-button" href="/api/records/${encodeURIComponent(record.id)}/audio" download aria-label="개별 M4A 내려받기">${icon('archive', 16)}</a></div>` : ''}
      ` : `<button class="video-preview" ${action} aria-label="${escape(record.authorName)} 영상 재생">${videoUrl ? `<video src="${escape(videoUrl)}#t=0.1" preload="metadata" muted playsinline aria-hidden="true"></video>` : ''}<span class="video-play">${icon('play', 25)}</span><span class="video-time">${seconds}</span></button>`}
    ${draft ? `<div class="local-actions"><button class="text-button" data-action="review-share" data-value="${escape(record.id)}">확인하고 공유하기 ${icon('arrow', 15)}</button></div>` : ''}
  </article>`;
}

function renderTimeline() {
  const page = document.querySelector('#page');
  const all = records();
  const groups = new Map();
  for (const item of all) {
    const date = dateKey(item.capturedAt);
    if ((state.date && date !== state.date) || (state.filter !== 'all' && state.filter !== item.kind)) continue;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  }
  const pending = mine().filter(record => record.approved === true).length;
  const deleting = pendingDeletes().length;
  page.innerHTML = `<div class="dashboard">
    <div class="page-intro diary-intro"><h1>일상 기록</h1><div class="diary-tools"><button class="icon-button" data-action="calendar" aria-label="날짜 선택" title="날짜 선택">${icon('timeline', 21)}</button><button class="icon-button" data-action="family" aria-label="가족 정보" title="가족 정보">${icon('people', 21)}</button></div></div>
    <div class="dashboard-grid"><div class="diary"><div class="capture-grid">${captureCard('video')}${captureCard('audio')}</div>
    ${!state.connected || pending || deleting ? `<div class="offline-banner" role="status">${icon('cloud', 18)}<div><strong>${[pending ? '업로드 대기 ' + word(pending) : '', deleting ? '삭제 반영 대기 ' + word(deleting) : ''].filter(Boolean).join(' · ') || '오프라인'}</strong><span>${pending || deleting ? '연결되면 반영됩니다.' : '공유 전까지 이 기기에 보관합니다.'}</span></div>${state.connected && (pending || deleting) ? '<button class="text-button" data-action="retry">다시 시도</button>' : ''}</div>` : ''}
    <section class="timeline"><div class="timeline-header"><div><h2>가족의 기록</h2>${state.date ? `<button class="text-button selected-day" data-action="clear-day">${dayLabel(dateAsNoon(state.date))} ${icon('x', 13)}</button>` : ''}</div>
    <div class="filter" aria-label="기록 종류">${Object.entries({ all: '전체', video: '영상', audio: '음성' }).map(([key, value]) => `<button data-action="filter" data-value="${key}" aria-pressed="${key === state.filter}">${value}</button>`).join('')}</div></div>
    ${groups.size ? [...groups].reverse().map(([date, entries]) => `<div class="timeline-day"><h3><span class="day-dot"></span>${dayLabel(dateAsNoon(date))}${date === dateKey(Date.now()) ? ' <span class="today-chip">오늘</span>' : ''}</h3><div class="day-records">${entries.map(recordCard).join('')}</div></div>`).join('') : '<div class="panel empty"><div class="empty-icon">' + icon('timeline', 24) + '</div><h3>아직 이곳에 기록이 없어요</h3><p>위의 영상이나 음성으로 새 기록을 남겨 보세요.</p></div>'}</section></div>
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
  const summary = `<div class="export-counts"><div><span>포함할 기록</span><strong>${word(available.length)}</strong><small>영상 ${word(video)} · 음성 ${word(audio)}</small></div><div><span>업로드 대기</span><strong>${word(pending.length)}</strong><small>이 기기 · 업로드 후 포함</small></div></div>`;
  return `${!state.connected ? '<p class="offline-banner">파일을 만들려면 인터넷 연결이 필요해요.</p>' : ''}${summary}${drafts ? `<p class="dialog-note">기기에만 저장된 ${word(drafts)}는 공유 후 포함됩니다.</p>` : ''}${familyDeletes().length ? '<p class="dialog-note">삭제 반영 후 내보낼 수 있습니다.</p>' : ''}<div class="export-grid">${types.map(([format, glyph, label, enabled]) => `<article class="panel export-card"><div class="export-icon">${icon(glyph, 23)}</div><div class="export-title"><h2>${label}</h2><span>.${format}</span></div><div class="export-actions">
    ${format === 'mp4' ? `<button class="button outline" data-action="preview" ${!enabled || !state.connected ? 'disabled' : ''}>${icon('play', 17)} 미리보기</button>` : ''}
    <button class="button outline" data-action="download" data-value="${format}" ${!enabled || !state.connected ? 'disabled' : ''}>${icon('archive', 17)} 내려받기</button></div></article>`).join('')}</div>`;
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
  modal(escape(family.name), `<p class="dialog-note">${icon('lock', 17)} 초대된 가족만 기록을 볼 수 있어요.</p><div class="member-list dialog-members">${family.members.map(member => `<div>${memberBadge(member)}<span>${escape(member.name)}</span>${member.id === user.id ? '<small>나</small>' : ''}</div>`).join('')}</div>
  ${family.inviteCode ? `<div class="invite-box"><label for="invite-code">가족 초대 코드</label><div><input id="invite-code" readonly value="${escape(family.inviteCode)}"><button class="button outline" data-action="copy-invite">${icon('copy', 16)} 복사</button></div><small>가족에게 직접 코드를 전해 주세요.</small></div>` : ''}`);
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
  const captureVersion = modal(video ? '3초 영상' : '음성 녹음', `<div class="capture-stage ${video ? 'camera-stage' : 'microphone-stage'}"><video id="live" muted playsinline hidden></video><span class="live-glyph">${icon(video ? 'video' : 'mic', 44)}</span><span class="record-counter" role="status">${video ? '3초' : '0:00 / 0:10'}</span></div><p class="dialog-note capture-hint">${video ? '3초 뒤 자동으로 끝납니다.' : '최대 10초. 언제든 녹음을 끝낼 수 있습니다.'} 확인한 뒤 보관하거나 버리세요.</p><button class="button primary full" id="record-start">${icon(video ? 'video' : 'mic', 19)} ${video ? '촬영' : '녹음'} 시작</button><button class="button primary full" id="record-stop" hidden>${icon('stop', 17)} 녹음 끝내기</button>`, 'capture-dialog');
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
      start.textContent = video ? '촬영 시작' : '녹음 시작';
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
        counter.textContent = video ? Math.max(1, Math.ceil((total * 1000 - elapsed) / 1000)) + '초' : `0:${String(Math.min(10, Math.floor(elapsed / 1000))).padStart(2, '0')} / 0:10`;
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
    <div class="dialog-actions"><button class="button outline" data-action="keep-capture" disabled>기기에 보관</button><button class="button primary" data-action="share-capture" disabled>가족과 공유</button></div>
    <div class="capture-review-actions"><button class="text-button" data-action="retake-capture">${video ? '다시 촬영' : '다시 녹음'}</button><button class="text-button discard-button" data-action="discard-capture">버리기</button></div>
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
    notify(approved ? (state.connected ? '공유를 준비하고 있습니다.' : '연결되면 가족과 공유됩니다.') : '이 기기에 보관했습니다.');
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
  modal('가족과 공유할까요?', `<${tag} class="dialog-media" controls playsinline src="${previewUrl}"></${tag}>
    <p class="dialog-note">아직 이 기기에만 저장되어 있습니다.${state.connected ? '' : ' 공유를 선택하면 연결될 때 업로드됩니다.'}</p>
    <div class="dialog-actions"><button class="button outline" data-action="close">기기에 보관</button><button class="button primary" data-action="approve-share" data-value="${escape(record.id)}">가족과 공유</button></div><p class="form-error" role="alert" hidden></p>`, 'share-dialog');
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
    notify(state.connected ? '공유를 준비하고 있습니다.' : '연결되면 가족과 공유됩니다.');
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
    <p class="delete-description">${localOnly ? '이 기기에서 삭제됩니다.' : state.connected ? '가족 공간에서도 삭제됩니다.' : '이 기기에서 먼저 지우고, 연결되면 가족 공간에서도 삭제됩니다.'} 삭제한 기록은 되돌릴 수 없습니다.</p>
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
  const params = new URLSearchParams({ ...state.range, format, tz: zone });
  const version = preview ? modal('내보낸 영상 미리보기', '<p class="dialog-note" role="status">서버에서 영상을 이어 붙이는 중…</p>', 'media-dialog') : null;
  if (!preview) notify('서버에서 파일을 만드는 중이에요.');
  const isCurrent = () => partition() === key && (!preview || (dialog.open && modalVersion === version));
  try {
    await sync();
    await readLocal();
    if (!isCurrent()) return;
    if (familyDeletes().length) throw new Error('deletions pending');
    const response = await fetch('/api/export?' + params, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    if (!isCurrent()) return;
    if (preview) {
      previewUrl = URL.createObjectURL(blob);
      modal('내보낸 영상 미리보기', `<video class="dialog-media" controls playsinline src="${previewUrl}"></video>`, 'media-dialog');
    } else {
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `우리의-일상-기록_${params.get('from')}_${params.get('to')}.${format}`;
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
  if (partition(session) !== partition()) {
    state.records = [];
    stopCapture?.();
    discardCaptureDraft();
    if (dialog.open) dialog.close();
  }
  state.session = session;
  await readLocal();
  await writeDevice('session', session?.user && session?.family ? {
    ...session, family: { ...session.family, inviteCode: undefined }
  } : null).catch(() => {});
  if (partition()) await loadRecords();
  render();
  sync();
}

async function loadRecords() {
  const key = partition();
  if (!key) return;
  try {
    const { records } = await api('/api/records');
    if (partition() !== key) return;
    await readLocal();
    if (partition() !== key) return;
    state.records = records.filter(record => !deleted(record));
    state.connected = true;
    await writeDevice('records:' + key, state.records).catch(() => {});
  } catch (error) {
    if (partition() !== key) return;
    if (!error.status) state.connected = false;
    if (error.status === 401 || error.status === 403) state.records = [];
    else {
      const cached = await readDevice('records:' + key).catch(() => []);
      if (partition() !== key) return;
      state.records = (cached || state.records).filter(record => !deleted(record));
    }
  }
}

const localChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('our-days-records') : null;
const announceLocalChange = () => localChannel?.postMessage('changed');
localChannel?.addEventListener('message', () => { refresh(); });

async function readLocal() {
  const before = JSON.stringify([state.outbox.map(({id, approved}) => [id, approved]), state.deletions]);
  [state.outbox, state.deletions] = await Promise.all([readOutbox(), readDeletions()]);
  if (dialog.open && dialog.dataset.recordId && deleted({ id: dialog.dataset.recordId })) dialog.close();
  return before !== JSON.stringify([state.outbox.map(({id, approved}) => [id, approved]), state.deletions]);
}

function sync() {
  if (syncTask) return syncTask;
  const key = partition();
  if (!key || !navigator.onLine) return Promise.resolve();
  syncTask = (async () => {
    syncing = true;
    let shouldRender = false;
    try {
      shouldRender = await readLocal();
      if (partition() !== key) return;
      if (!pendingDeletes().length && !mine().some(record => record.approved === true && !notifiedUploads.has(record.id))) return;
      shouldRender = true;
      const result = await syncRecords({
        partition: key, authorId: state.session.user.id, familyId: state.session.family.id,
        store: device, api, isCurrent: () => partition() === key, skipIds: notifiedUploads,
        onRejected(record) {
          notifiedUploads.add(record.id);
          notify('파일을 읽지 못했습니다. 기기에 보관 중이니 다시 시도하거나 삭제해 주세요.', true);
        },
        async onUploaded(record) {
          await readLocal();
          if (partition() !== key || deleted(record)) return;
          state.records = [...shared().filter(item => item.id !== record.id), record];
          await writeDevice('records:' + key, state.records).catch(() => {});
        }
      });
      if (partition() !== key) return;
      if (result.uploaded) notify(`기록 ${word(result.uploaded)}를 가족과 공유했습니다.`);
      else if (result.deleted) notify('삭제를 반영했습니다.');
      if (result.uploaded || result.deleted) announceLocalChange();
    } catch (error) {
      if (partition() === key) {
        if (!error.status) state.connected = false;
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
  if (refreshing || !partition()) return;
  refreshing = true;
  const before = JSON.stringify(state.records);
  const connected = state.connected;
  try {
    const localChanged = await readLocal();
    if (localChanged) { state.records = shared(); render(); }
    if (syncing || !navigator.onLine) return;
    const session = await api('/api/session');
    if (JSON.stringify(session) !== JSON.stringify(state.session)) {
      await useSession(session);
      return;
    }
    await loadRecords();
    if (before !== JSON.stringify(state.records) || connected !== state.connected) render();
  } catch {
    if (state.connected) { state.connected = false; render(); }
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
    case 'switch':
    case 'logout':
      try {
        await api('/api/logout', { method: 'POST' });
        if (dialog.open) dialog.close();
        state.records = [];
        state.filter = 'all';
        state.date = '';
        await useSession({ user: null, family: null, demo: state.session.demo });
      } catch { notify('로그아웃하려면 연결이 필요해요.', true); }
      break;
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
  error.hidden = true;
  submit.disabled = true;
  try {
    const action = form.dataset.form;
    if (action === 'edit') {
      const { record } = await api('/api/records/' + encodeURIComponent(form.dataset.id), { method: 'PATCH', json: fields });
      state.records = state.records.map(item => item.id === record.id ? record : item);
      await writeDevice('records:' + partition(), state.records).catch(() => {});
      dialog.close();
      render();
      notify('텍스트를 수정했어요.');
      return;
    }
    const path = { login: '/api/login', 'create-family': '/api/family', join: '/api/invite/accept' }[action];
    await useSession(await api(path, { method: 'POST', json: fields }));
  } catch (failure) {
    error.textContent = !failure.status ? '인터넷 연결을 확인해 주세요.' :
      form.dataset.form === 'login' && failure.status === 401 ? '이메일과 비밀번호를 확인해 주세요.' : failure.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener('change', event => {
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
window.addEventListener('online', () => { refresh(); });
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 3500);

async function start() {
  setPage();
  await readLocal().catch(() => {});
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    await useSession(await api('/api/session'));
  } catch {
    state.connected = false;
    state.session = await readDevice('session').catch(() => null);
    if (partition()) state.records = await readDevice('records:' + partition()).catch(() => []) || [];
    render();
  }
}

start();

