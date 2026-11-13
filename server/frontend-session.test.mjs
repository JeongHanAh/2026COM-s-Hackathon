import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as authState from '../public/auth-state.js';
import { commandLabel } from '../public/easter-egg.js';
import { timelineGroups } from '../public/record-order.js';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const memberSession = {
  user: { id: 'a', name: '서연', role: 'owner', member: true },
  family: { id: 'family-1', name: '비공개 가족', members: [{ id: 'a', name: '서연', role: 'owner' }] },
  backend: 'supabase', demo: false, auth: { signup: true, recovery: true }
};
const cachedRecord = { id: 'private-record', authorId: 'a', authorName: '서연', kind: 'audio', capturedAt: '2026-11-14T00:00:00Z', durationMs: 3000, transcript: 'private words', transcriptStatus: 'ready', mediaUrl: '/api/records/private-record/media' };

function element() {
  return { innerHTML: '', className: '', textContent: '', hidden: false, open: false, dataset: {},
    classList: { toggle() {}, contains() { return false; } }, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, close() { this.open = false; }, focus() {} };
}

async function browserModel(fetcher) {
  const elements = new Map(['#app', '#dialog', '#notice', '#page', '#connection'].map(key => [key, element()]));
  const listeners = new Map();
  const cached = new Map([['session', authState.offlineSession(memberSession)], ['records:a/family-1', [cachedRecord]]]);
  const store = { readDevice: async key => cached.get(key), writeDevice: async (key, value) => { cached.set(key, value); },
    readOutbox: async () => [], readDeletions: async () => [] };
  const context = vm.createContext({ ...store, ...authState, commandLabel, timelineGroups,
    icon: () => '', initHome() {}, device: store, syncRecords: async () => ({ uploaded: 0, deleted: 0 }),
    savePending() {}, queueDeletion() {}, approvePending() {}, fetch: (...args) => fetcher(...args),
    document: { hidden: false, querySelector: key => elements.get(key) || null, addEventListener(type, listener) { listeners.set(type, listener); } },
    window: { addEventListener() {}, scrollTo() {} }, navigator: { onLine: true },
    location: { hash: '#timeline', search: '', pathname: '/' }, history: { replaceState() {} },
    URL, URLSearchParams, AbortSignal, Response, Intl, console,
    FormData: class extends Map { constructor(form) { super(Object.entries(form.fields)); } },
    setInterval() {}, clearTimeout() {}, setTimeout() { return 1; }
  });
  vm.runInContext(source + '\n;globalThis.appUnderTest = { state, start, refresh, clearAccess, useSession, exportFile, render, api };', context);
  await context.appUnderTest.start();
  return { app: context.appUnderTest, elements, cached, listeners };
}

const ok = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('actual startup renders a server error instead of restoring private records on HTTP failure', async () => {
  const model = await browserModel(() => new Response(JSON.stringify({ error: '서버 연결 설정을 확인해 주세요.' }), { status: 503 }));
  assert.equal(model.app.state.session.user, null);
  assert.equal(model.app.state.records.length, 0);
  assert.equal(model.cached.get('session'), null);
  assert.equal(model.cached.get('records:a/family-1').length, 0);
  assert.match(model.elements.get('#app').innerHTML, /다시 연결/);
  assert.doesNotMatch(model.elements.get('#app').innerHTML, /data-form="login"/);
});

test('actual startup restores approved offline display data only after a fetch failure', async () => {
  const model = await browserModel(() => { throw new TypeError('network offline'); });
  assert.equal(model.app.state.session.user.id, 'a');
  assert.equal(model.app.state.connected, false);
  assert.equal(model.app.state.records[0].id, cachedRecord.id);
  assert.match(model.elements.get('#page').innerHTML, /오프라인/);
});

test('anonymous cloud session clears previous member cache and offers cloud auth controls', async () => {
  const anonymous = authState.anonymousSession(memberSession);
  const model = await browserModel(() => ok(anonymous));
  assert.equal(model.app.state.session.user, null);
  assert.equal(model.cached.get('session'), null);
  assert.equal(model.cached.get('records:a/family-1').length, 0);
  assert.match(model.elements.get('#app').innerHTML, /계정 만들기/);
  assert.match(model.elements.get('#app').innerHTML, /비밀번호 찾기/);
  assert.doesNotMatch(model.elements.get('#app').innerHTML, /시연 계정/);
});

test('a delayed session refresh cannot restore private UI after logout', async () => {
  let pendingSession;
  let requestStarted;
  const reached = new Promise(resolve => { requestStarted = resolve; });
  let hold = false;
  const model = await browserModel(path => {
    if (path === '/api/records') return ok({ records: [cachedRecord] });
    if (hold) { requestStarted(); return new Promise(resolve => { pendingSession = resolve; }); }
    return ok(memberSession);
  });
  hold = true;
  const refresh = model.app.refresh();
  await reached;
  await model.app.clearAccess();
  pendingSession(ok(memberSession));
  await refresh;
  assert.equal(model.app.state.session.user, null);
  assert.equal(model.app.state.records.length, 0);
  assert.equal(model.cached.get('session'), null);
  assert.match(model.elements.get('#app').innerHTML, /data-form="login"/);
});

test('membership denial during record fetch clears the session instead of retaining local drafts on screen', async () => {
  const model = await browserModel(path => path === '/api/session' ? ok(memberSession)
    : new Response(JSON.stringify({ error: '공간에 먼저 가입해 주세요.', code: 'FAMILY_REQUIRED' }), { status: 403 }));
  assert.equal(model.app.state.session.user, null);
  assert.equal(model.app.state.records.length, 0);
  assert.equal(model.cached.get('session'), null);
  assert.match(model.elements.get('#app').innerHTML, /data-form="login"/);
});

test('recovery session only shows password update and is not persisted for offline access', async () => {
  let recordRequests = 0;
  const model = await browserModel(path => {
    if (path === '/api/records') recordRequests++;
    return ok({ ...memberSession, recovery: true });
  });
  assert.equal(recordRequests, 0);
  assert.equal(model.cached.get('session'), null);
  assert.match(model.elements.get('#app').innerHTML, /data-form="password-update"/);
  assert.doesNotMatch(model.elements.get('#app').innerHTML, /video-preview/);
});

test('logout revocation failure clears private UI and cache because the server already cleared the cookie', async () => {
  const message = '이 기기에서는 로그아웃했지만 서버의 로그인 연결은 종료하지 못했어요.';
  const model = await browserModel(path => path === '/api/logout'
    ? new Response(JSON.stringify({ error: message, code: 'LOGOUT_REVOKE_FAILED' }), { status: 503 })
    : ok(path === '/api/records' ? { records: [cachedRecord] } : memberSession));
  await model.listeners.get('click')({ target: { closest: () => ({ dataset: { action: 'logout' } }) } });
  assert.equal(model.app.state.session.user, null);
  assert.equal(model.app.state.records.length, 0);
  assert.equal(model.cached.get('session'), null);
  assert.equal(model.cached.get('records:a/family-1').length, 0);
  assert.equal(model.elements.get('#notice').textContent, message);
  assert.match(model.elements.get('#app').innerHTML, /data-form="login"/);
});

test('network-only logout failure keeps the account and explains that logout needs a connection', async () => {
  const model = await browserModel(path => {
    if (path === '/api/logout') throw new TypeError('offline');
    return ok(path === '/api/records' ? { records: [cachedRecord] } : memberSession);
  });
  await model.listeners.get('click')({ target: { closest: () => ({ dataset: { action: 'logout' } }) } });
  assert.equal(model.app.state.session.user.id, 'a');
  assert.equal(model.cached.get('session').user.id, 'a');
  assert.equal(model.elements.get('#notice').textContent, '로그아웃하려면 연결이 필요해요.');
});

test('a late family creation response cannot restore access after logout', async () => {
  let finish;
  let markStarted;
  const reached = new Promise(resolve => { markStarted = resolve; });
  const model = await browserModel(path => {
    if (path === '/api/family') { markStarted(); return new Promise(resolve => { finish = resolve; }); }
    return ok({ ...memberSession, family: null, user: { ...memberSession.user, member: false } });
  });
  const formError = element();
  const button = element();
  const form = { dataset: { form: 'create-family' }, fields: { name: '새 공간' }, querySelector: selector => selector === '.form-error' ? formError : button };
  const submit = model.listeners.get('submit')({ target: { closest: () => form }, preventDefault() {} });
  await reached;
  await model.app.clearAccess();
  finish(ok(memberSession));
  await submit;
  assert.equal(model.app.state.session.user, null);
  assert.equal(model.cached.get('session'), null);
  assert.match(model.elements.get('#app').innerHTML, /data-form="login"/);
});

test('a late unauthorized export cannot sign out a newly authenticated session with the same family', async () => {
  let finish;
  let markStarted;
  const reached = new Promise(resolve => { markStarted = resolve; });
  const model = await browserModel(path => {
    if (path.startsWith('/api/export?')) { markStarted(); return new Promise(resolve => { finish = resolve; }); }
    return ok(path === '/api/records' ? { records: [cachedRecord] } : memberSession);
  });
  const download = model.app.exportFile('txt');
  await reached;
  await model.app.clearAccess();
  await model.app.useSession(memberSession);
  finish(new Response('', { status: 401 }));
  await download;
  assert.equal(model.app.state.session.user.id, 'a');
  assert.equal(model.cached.get('session').user.id, 'a');
});

test('losing owner rights closes an open invitation dialog even when family identity stays the same', async () => {
  const model = await browserModel(path => ok(path === '/api/records' ? { records: [] } : memberSession));
  model.elements.get('#dialog').open = true;
  await model.app.useSession({ ...memberSession, user: { ...memberSession.user, role: 'member' } });
  assert.equal(model.elements.get('#dialog').open, false);
  assert.equal(model.app.state.session.user.role, 'member');
});

test('family membership loss from a private detail endpoint clears access immediately', async () => {
  const model = await browserModel(path => path === '/api/home'
    ? new Response(JSON.stringify({ error: '공간에 먼저 가입해 주세요.', code: 'FAMILY_REQUIRED' }), { status: 403 })
    : ok(path === '/api/records' ? { records: [cachedRecord] } : memberSession));
  await assert.rejects(model.app.api('/api/home'), { status: 403 });
  assert.equal(model.app.state.session.user, null);
  assert.equal(model.app.state.records.length, 0);
  assert.equal(model.cached.get('session'), null);
});

test('an owner-only action denial does not log an otherwise authorized member out', async () => {
  const model = await browserModel(path => path === '/api/invite/rotate'
    ? new Response(JSON.stringify({ error: '소유자만 초대 코드를 바꿀 수 있습니다.', code: 'OWNER_REQUIRED' }), { status: 403 })
    : ok(path === '/api/records' ? { records: [cachedRecord] } : memberSession));
  await assert.rejects(model.app.api('/api/invite/rotate', { method: 'POST' }), { status: 403 });
  assert.equal(model.app.state.session.user.id, 'a');
  assert.equal(model.app.state.records.length, 1);
});
