import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { createCloudApp } from './cloud.mjs';

// These HTTP integration tests simulate the remote Auth/repository contract.
// Database RLS/RPC correctness has its own SQL integration suite.
const config = { supabaseUrl: 'https://test.supabase.co', supabaseKey: 'sb_publishable_test',
  sessionSecret: 'private-test-secret-longer-than-32-characters', origin: 'https://still.example', secureCookie: true };
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const mediaBytes = Buffer.from('RIFF0000WAVEvoice data');

function dispatch(app, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(request, { method, url: path, headers: { host: 'still.example', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const chunks = [];
    const output = new Headers();
    const response = new Writable({ write(chunk, _, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.setHeader = (key, value) => output.set(key, value);
    response.writeHead = (status, extra = {}) => { response.statusCode = status; response.headersSent = true; for (const [key, value] of Object.entries(extra)) output.set(key, value); };
    response.once('error', reject);
    response.once('finish', () => resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status: response.statusCode, headers: output })));
    app.emit('request', request, response);
  });
}

function browser(app) {
  let cookie;
  return { request: async (path, { json, headers, ...options } = {}) => {
    const response = await dispatch(app, path, { ...options,
      headers: { ...(cookie ? { cookie } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(json ? { body: JSON.stringify(json) } : {}) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  } };
}

function fakeCloud() {
  const users = Object.fromEntries(['alice', 'bob', 'eve'].map(name => [name, { id: randomUUID(), email: `${name}@example.test`, user_metadata: { name } }]));
  const tokens = new Map();
  const families = new Map();
  const membership = new Map();
  const records = new Map();
  const objects = new Map();
  let putGate;
  let exportGate;
  let authUnavailable = false;
  const fetchImpl = async (url, init) => {
    if (authUnavailable) throw new Error('Auth unavailable');
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    if (path.endsWith('/token')) {
      const name = body.email?.split('@')[0];
      const user = users[name];
      if (!user || body.password !== 'test-password-123') return Response.json({ error: 'invalid' }, { status: 400 });
      const token = randomUUID(); tokens.set(token, user);
      return Response.json({ access_token: token, refresh_token: randomUUID(), expires_in: 3600 });
    }
    if (path.endsWith('/user')) {
      const user = tokens.get(init.headers.Authorization?.slice(7));
      return Response.json(user || {}, { status: user ? 200 : 401 });
    }
    if (path.endsWith('/logout')) return new Response(null, { status: 204 });
    throw new Error('Unexpected Auth request');
  };
  const repository = { forUser: token => {
    const user = tokens.get(token);
    assert.ok(user, 'API must forward a verified user token');
    const family = () => families.get(membership.get(user.id));
    const visible = record => record && record.familyId === family()?.id && record.status !== 'deleted'
      && (record.status === 'ready' || record.authorId === user.id);
    const session = async () => ({ user: { id: user.id, name: user.user_metadata.name, member: Boolean(family()), role: family()?.ownerId === user.id ? 'owner' : 'member' },
      family: family() ? { ...family(), members: [...membership].filter(([, id]) => id === family().id).map(([id]) => ({ id })) } : null });
    return { session,
      createFamily: async name => { if (family()) throw fail(409, '이미 공간에 참여했습니다.'); const value = { id: randomUUID(), name, ownerId: user.id, inviteCode: randomUUID().replaceAll('-', '') }; families.set(value.id, value); membership.set(user.id, value.id); },
      joinFamily: async code => { const found = [...families.values()].find(f => f.inviteCode === code); if (!found) throw fail(400, '초대 코드를 확인해 주세요.'); if (family()) throw fail(409, '이미 공간에 참여했습니다.'); membership.set(user.id, found.id); },
      rotateInvite: async () => { if (family()?.ownerId !== user.id) throw fail(403, '공간을 만든 사람만 초대할 수 있습니다.'); family().inviteCode = randomUUID().replaceAll('-', ''); },
      listRecords: async () => [...records.values()].filter(r => visible(r) && r.status === 'ready').map(r => ({ ...r })),
      getRecord: async id => visible(records.get(id)) ? { ...records.get(id) } : null,
      reserveRecord: async info => {
        const previous = records.get(info.id);
        if (previous?.authorId !== user.id && previous) throw fail(403, '다른 사람의 기록입니다.');
        if (previous?.status === 'deleted') throw fail(410, '이미 삭제된 기록입니다.', 'RECORD_DELETED');
        if (previous) return { ...previous };
        const record = { ...info, status: 'pending', authorId: user.id, authorName: user.user_metadata.name, familyId: family().id,
          storagePath: family().id + '/' + user.id + '/' + info.id, transcriptStatus: info.kind === 'audio' ? 'processing' : null, transcript: null };
        records.set(info.id, record); return { ...record };
      },
      putObject: async (record, bytes) => { if (putGate) await putGate(); if (records.get(record.id)?.status === 'deleted') throw fail(410, '이미 삭제된 기록입니다.', 'RECORD_DELETED'); objects.set(record.id, Buffer.from(bytes)); },
      readObject: async record => { if (!visible(records.get(record.id))) throw fail(404, '기록을 찾을 수 없습니다.'); return objects.get(record.id); },
      finishRecord: async id => { const record = records.get(id); if (!record || record.status === 'deleted') throw fail(410, '이미 삭제된 기록입니다.', 'RECORD_DELETED'); record.status = 'ready'; record.uploadedAt = record.updatedAt = new Date().toISOString(); return { ...record }; },
      deleteRecord: async id => { const record = records.get(id); if (record && record.authorId !== user.id) throw fail(403, '작성자만 삭제할 수 있습니다.'); if (record) { record.status = 'deleted'; return { ...record }; } records.set(id, { id, status: 'deleted', authorId: user.id, familyId: family().id }); return null; },
      removeObject: async record => { objects.delete(record.id); },
      setTranscript: async (id, text, options = {}) => { const record = records.get(id); if (!visible(record) || record.status !== 'ready') throw fail(404, '기록을 찾을 수 없습니다.'); if (!options.automatic || record.transcriptStatus === 'processing') { record.transcript = text; record.transcriptStatus = text ? 'ready' : 'failed'; } return { ...record }; },
      getHome: async () => ({ canEdit: family().ownerId === user.id, address: family().ownerId === user.id ? 'owner only' : undefined, location: family().location || null, status: '우리 집 상태 미확인' }),
      updateHome: async () => { if (family().ownerId !== user.id) throw fail(403, '주소 등록자만 수정할 수 있습니다.'); return { address: 'updated' }; },
      updateHomeLocation: async location => { if (family().ownerId !== user.id) throw fail(403, '지역 등록자만 수정할 수 있습니다.'); family().location = location; return { canEdit: true, location }; },
    };
  } };
  const mediaImpl = {
    validateMedia: async () => ({ durationMs: 2000, mimeType: 'audio/wav' }),
    transcribeAudio: async () => ({ status: 'ready', text: '오늘도 잘 지냈어.' }),
    renderArchive: async (items, options) => {
      if (exportGate) await exportGate();
      return { data: Buffer.from(items.map(item => item.id).join('\n')), extension: options.format, contentType: 'text/plain' };
    },
    renderIndividualAudio: async () => ({ data: Buffer.from('voice'), extension: 'm4a', contentType: 'audio/mp4' }),
  };
  const open = async (overrides = {}, services = {}) => createCloudApp({ config: { ...config, ...overrides }, repository, fetchImpl, mediaImpl, ...services });
  return { users, families, records, objects, open, setPutGate: value => { putGate = value; }, setExportGate: value => { exportGate = value; },
    setAuthUnavailable: value => { authUnavailable = value; } };
}

async function login(client, name) {
  const response = await client.request('/api/login', { method: 'POST', json: { email: `${name}@example.test`, password: 'test-password-123' } });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

const upload = (client, id, capturedAt = '2026-11-09T10:00:00.000Z') => client.request('/api/records', { method: 'POST', body: mediaBytes,
  headers: { 'content-type': 'audio/wav', 'x-record-id': id, 'x-record-kind': 'audio', 'x-captured-at': capturedAt, 'x-duration-ms': '2000' } });

test('two independently configured gateways share records only after login and family membership', async () => {
  const cloud = fakeCloud();
  const one = await cloud.open();
  const two = await cloud.open({ sessionSecret: 'different-private-clone-session-secret-1234567890' });
  const alice = browser(one), bob = browser(two), eve = browser(two);
  assert.equal((await bob.request('/api/records')).status, 401);
  assert.equal((await bob.request('/api/health')).status, 200);
  await login(alice, 'alice'); await login(bob, 'bob'); await login(eve, 'eve');
  assert.equal((await bob.request('/api/records')).status, 403);
  const created = await alice.request('/api/family', { method: 'POST', json: { name: '함께' } });
  const inviteCode = (await created.json()).family.inviteCode;
  assert.equal((await bob.request('/api/invite/accept', { method: 'POST', json: { code: inviteCode } })).status, 200);
  await eve.request('/api/family', { method: 'POST', json: { name: '다른 공간' } });
  const id = randomUUID();
  assert.equal((await upload(alice, id)).status, 201);
  assert.equal((await upload(alice, id)).status, 200, 'upload replay is idempotent');
  const listed = (await (await bob.request('/api/records')).json()).records;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].capturedAt, '2026-11-09T10:00:00.000Z');
  assert.ok(listed[0].uploadedAt);
  assert.equal(listed[0].storagePath, undefined);
  assert.deepEqual((await (await eve.request('/api/records')).json()).records, []);
  assert.equal((await eve.request(`/api/records/${id}/media`)).status, 404);
  assert.equal((await bob.request(`/api/records/${id}/media`, { headers: { range: 'bytes=0-3' } })).status, 206);
  assert.equal((await bob.request(`/api/records/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await bob.request('/api/invite/rotate', { method: 'POST' })).status, 403);
  assert.equal((await (await bob.request('/api/home')).json()).home.address, undefined);
  assert.equal((await alice.request(`/api/records/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await bob.request(`/api/records/${id}/media`)).status, 404);
  assert.equal((await upload(alice, id)).status, 410);
  assert.equal(cloud.objects.has(id), false);
});

test('cloud location lookup, canonical save and news respect membership and owner boundaries', async () => {
  const cloud = fakeCloud();
  const location = { id: '1835848', label: 'Seoul, South Korea', region: 'Seoul', lat: 37.57, lon: 126.98, newsQuery: 'Seoul' };
  let calls = 0;
  let unavailable = false;
  const placeNews = {
    searchPlaces: async query => { calls++; assert.equal(query, '서울'); return [location]; },
    resolveLocation: async input => { calls++; assert.equal(input.id, location.id); return location; },
    getNews: async input => {
      calls++; assert.deepEqual(input, location);
      if (unavailable) throw fail(503, '소식을 불러오지 못했습니다.', 'NEWS_UNAVAILABLE');
      return { articles: [{ title: 'Regional headline', source: 'example.test', url: 'https://example.test/news', observedAt: '2026-11-14T00:00:00.000Z' }], query: 'Seoul', stale: false };
    },
  };
  const one = await cloud.open({}, { placeNews });
  const two = await cloud.open({}, { placeNews });
  const owner = browser(one), member = browser(two), outsider = browser(two);
  assert.equal((await owner.request('/api/home/news')).status, 401);
  await login(owner, 'alice'); await login(member, 'bob'); await login(outsider, 'eve');
  const created = await owner.request('/api/family', { method: 'POST', json: { name: '가족' } });
  const code = (await created.json()).family.inviteCode;
  assert.equal((await member.request('/api/home/news')).status, 403);
  await member.request('/api/invite/accept', { method: 'POST', json: { code } });
  await outsider.request('/api/family', { method: 'POST', json: { name: '별도 공간' } });
  assert.equal((await owner.request('/api/home/news')).status, 409);
  assert.equal((await member.request('/api/home/search', { method: 'POST', json: { query: '서울' } })).status, 403);
  assert.equal((await member.request('/api/home/location', { method: 'PUT', json: { location } })).status, 403);
  assert.equal(calls, 0);
  assert.deepEqual((await (await owner.request('/api/home/search', { method: 'POST', json: { query: '서울' } })).json()).places, [location]);
  const saved = await owner.request('/api/home/location', { method: 'PUT', json: { location: { ...location, newsQuery: 'private address override' } } });
  assert.deepEqual((await saved.json()).home.location, location);
  const shared = (await (await member.request('/api/home')).json()).home;
  assert.equal(shared.address, undefined);
  assert.deepEqual(shared.location, location);
  assert.equal((await (await member.request('/api/home/news')).json()).news.articles.length, 1);
  assert.equal((await outsider.request('/api/home/news')).status, 409);
  unavailable = true;
  const failed = await member.request('/api/home/news');
  assert.equal(failed.status, 503, 'provider failure is not disguised as no matching articles');
  const page = await dispatch(one, '/');
  assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/www\.openstreetmap\.org/);
});

test('deletion during a delayed upload does not create a visible record', async () => {
  const cloud = fakeCloud();
  const app = await cloud.open();
  const alice = browser(app);
  await login(alice, 'alice'); await alice.request('/api/family', { method: 'POST', json: { name: '함께' } });
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  cloud.setPutGate(async () => { entered(); await waiting; });
  const id = randomUUID();
  const sending = upload(alice, id);
  await started;
  assert.equal((await alice.request(`/api/records/${id}`, { method: 'DELETE' })).status, 204);
  release();
  assert.equal((await sending).status, 410);
  assert.deepEqual((await (await alice.request('/api/records')).json()).records, []);
  assert.equal(cloud.objects.has(id), false);
});

test('exports retain capture chronology, have bounds, and refuse deletion races', async () => {
  const cloud = fakeCloud();
  const app = await cloud.open({ maxExportRecords: 2 });
  const alice = browser(app);
  await login(alice, 'alice'); await alice.request('/api/family', { method: 'POST', json: { name: '함께' } });
  const older = randomUUID(), newer = randomUUID();
  await upload(alice, newer, '2026-11-10T10:00:00.000Z');
  await upload(alice, older, '2026-11-09T10:00:00.000Z');
  const path = '/api/export?from=2026-11-09&to=2026-11-10&format=txt';
  const exported = await alice.request(path);
  assert.equal(exported.status, 200);
  assert.equal(await exported.text(), `${older}\n${newer}`);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  cloud.setExportGate(async () => { entered(); await wait; });
  const rendering = alice.request(path);
  await started;
  assert.equal((await alice.request(path)).status, 429, 'same user cannot run overlapping exports');
  await alice.request(`/api/records/${older}`, { method: 'DELETE' });
  release();
  assert.equal((await rendering).status, 409);
  cloud.setExportGate(null);
  await upload(alice, randomUUID()); await upload(alice, randomUUID());
  assert.equal((await alice.request(path)).status, 422, 'large ranges must be narrowed');
});

test('cross-site writes are rejected before authentication and cloud mode never seeds demo users', async () => {
  const cloud = fakeCloud();
  const app = await cloud.open();
  const client = browser(app);
  const session = await (await client.request('/api/session')).json();
  assert.equal(session.demo, false);
  assert.equal(session.backend, 'supabase');
  assert.equal(session.auth.signup, true);
  assert.equal((await client.request('/api/login', { method: 'POST', headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }, json: { email: 'alice@example.test', password: 'test-password-123' } })).status, 403);
});

test('HTTP logout clears the cookie even when Auth cannot verify the current user', async () => {
  const cloud = fakeCloud();
  const client = browser(await cloud.open());
  await login(client, 'alice');
  cloud.setAuthUnavailable(true);
  const result = await client.request('/api/logout', { method: 'POST' });
  assert.equal(result.status, 503);
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await result.json()).code, 'LOGOUT_REVOKE_FAILED');
  assert.equal((await (await client.request('/api/session')).json()).user, null);
});
