import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createApp } from './index.mjs';

async function start(dataDir, options) {
  const server = await createApp({ dataDir, demo: false, ...options });
  return server;
}

// Exercise the HTTP handler and Node streams without requiring a bound network port.
function dispatch(app, path, { method = 'GET', headers, body }) {
  return new Promise((resolve, reject) => {
    const request = body instanceof Readable ? body : Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(request, { method, url: path, headers: { host: 'localhost:4173', ...Object.fromEntries(headers) }, socket: { remoteAddress: '127.0.0.1' } });
    const chunks = [];
    const output = new Headers();
    const response = new Writable({ write(chunk, _encoding, next) { chunks.push(chunk); next(); } });
    response.setHeader = (key, value) => output.set(key, value);
    response.writeHead = (status, extra = {}) => {
      response.statusCode = status;
      response.headersSent = true;
      for (const [key, value] of Object.entries(extra)) output.set(key, value);
    };
    response.once('error', reject);
    response.once('finish', () => resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status: response.statusCode, headers: output })));
    app.emit('request', request, response);
  });
}

function browser(app) {
  let cookie = '';
  const request = async (path, { json, ...init } = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    if (json) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(json);
    }
    const response = await dispatch(app, path, { ...init, headers });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    return response;
  };
  const login = (account) => request('/api/login', { method: 'POST', json: {
    email: `family-${account}@example.test`, password: process.env[`OURDAYS_PASSWORD_${account.toUpperCase()}`] || 'demo2026!',
  } });
  return { request, login };
}

test('family invitation, residence privacy, session isolation and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'our-days-api-'));
  let app = await start(dir, { emptyFamily: true });
  try {
    const member = browser(app);
    const owner = browser(app);
    assert.equal((await owner.request('/api/records')).status, 401);
    const ownerLogin = await owner.login('a');
    assert.match(ownerLogin.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.deepEqual(await ownerLogin.json(), { user: { id: 'family-a', name: '서연', role: null, member: false }, family: null, demo: false });
    assert.equal((await member.login('b')).status, 200);
    assert.equal((await member.request('/api/home')).status, 403);
    assert.equal((await member.request(`/api/records/${randomUUID()}`, { method: 'DELETE' })).status, 403);

    const familyCreation = await owner.request('/api/family', { method: 'POST', json: { name: '우리 가족' } });
    assert.equal(familyCreation.status, 201);
    const { family } = await familyCreation.json();
    assert.ok(family.inviteCode);
    assert.equal((await member.request('/api/invite/accept', { method: 'POST', json: { code: 'wrong' } })).status, 400);
    const joined = await member.request('/api/invite/accept', { method: 'POST', json: { code: family.inviteCode.toLowerCase() } });
    assert.equal(joined.status, 200);
    const joinedBody = await joined.json();
    assert.equal(joinedBody.user.id, 'family-b');
    assert.equal(joinedBody.family.members.length, 2);
    assert.equal('inviteCode' in joinedBody.family, false);
    assert.equal((await owner.request('/api/home', { method: 'PUT', json: { address: '테스트 주소' }, headers: { origin: 'https://other.test' } })).status, 403);
    const writeHome = await owner.request('/api/home', { method: 'PUT', json: { address: '테스트 주소' } });
    assert.equal((await writeHome.json()).home.address, '테스트 주소');
    const hidden = (await (await member.request('/api/home')).json()).home;
    assert.equal('address' in hidden, false);
    assert.equal(hidden.status, '동네 피해 관측 · 우리 집 상태 미확인');
    assert.equal((await member.request('/api/home', { method: 'PUT', json: { address: '테스트' } })).status, 403);
    assert.equal((await owner.request('/api/logout', { method: 'POST' })).status, 204);
    assert.equal((await owner.request('/api/records')).status, 401);
    assert.equal((await member.request('/api/records')).status, 200);

    app = await start(dir);
    const reopened = browser(app);
    assert.equal((await reopened.login('a')).status, 200);
    assert.equal((await (await reopened.request('/api/home')).json()).home.address, '테스트 주소');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const localFFmpeg = fileURLToPath(new URL(`../.tools/ffmpeg/ffmpeg${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH || (existsSync(localFFmpeg) ? localFFmpeg : 'ffmpeg');
const probeName = `ffprobe${process.platform === 'win32' ? '.exe' : ''}`;
const probeSibling = isAbsolute(ffmpeg) && join(dirname(ffmpeg), probeName);
const ffprobe = process.env.FFPROBE_PATH || (probeSibling && existsSync(probeSibling) ? probeSibling : probeName);

function makeMediaFixture(file, kind, seconds = kind === 'video' ? 3 : 10, streaming = false) {
  const input = kind === 'video' ? `color=c=tan:s=160x90:r=24:d=${seconds}` : `sine=frequency=330:duration=${seconds}`;
  const encoding = kind === 'video' ? ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p'] : ['-c:a', 'aac'];
  const options = streaming ? ['-c:a', 'libopus', '-live', '1'] : encoding;
  const run = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', input, ...options, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.error?.message || run.stderr);
}

function uploadHeaders(fixture, authorId) {
  return {
    'content-type': fixture.mimeType || `${fixture.type}/mp4`, 'x-record-id': fixture.id, 'x-record-kind': fixture.type,
    'x-captured-at': fixture.day, 'x-duration-ms': fixture.duration, 'x-record-owner': authorId,
  };
}

test('legacy upload timestamps survive restart and only manual content changes update them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'our-days-record-time-'));
  const statePath = join(dir, 'state.json');
  const earlier = { id: randomUUID(), capturedAt: '2026-11-11T09:00:00.000Z', uploadedAt: '2026-11-13T09:00:00.000Z', transcript: '먼저 남긴 기록' };
  const later = { id: randomUUID(), capturedAt: '2026-11-12T09:00:00.000Z', uploadedAt: '2026-11-12T10:00:00.000Z', transcript: '나중에 남긴 기록' };
  const missing = { id: randomUUID(), capturedAt: '2026-11-10T09:00:00.000Z', transcript: '파일이 없는 기존 기록' };
  try {
    await start(dir, { emptyFamily: false });
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    for (const item of [earlier, later, missing]) {
      const fileName = `${item.id}.m4a`;
      state.records[item.id] = { id: item.id, capturedAt: item.capturedAt, transcript: item.transcript,
        fileName, authorId: 'family-a', kind: 'audio', mimeType: 'audio/mp4', durationMs: 1000, transcriptStatus: 'ready' };
      if (item.uploadedAt) {
        const file = join(dir, 'media', fileName);
        await writeFile(file, 'existing recording');
        await utimes(file, new Date(item.uploadedAt), new Date(item.uploadedAt));
      }
    }
    await writeFile(statePath, JSON.stringify(state));

    const owner = browser(await start(dir));
    assert.equal((await owner.login('a')).status, 200);
    const list = (await (await owner.request('/api/records')).json()).records;
    assert.deepEqual(list.map(record => record.id), [missing.id, earlier.id, later.id]);
    for (const item of [earlier, later, missing]) {
      const record = list.find(record => record.id === item.id);
      assert.equal(record.capturedAt, item.capturedAt);
      assert.equal(record.uploadedAt, item.uploadedAt || item.capturedAt);
      assert.equal(record.updatedAt, record.uploadedAt);
    }
    const patch = await owner.request(`/api/records/${earlier.id}`, { method: 'PATCH', json: { transcript: '고친 기록' } });
    const edited = (await patch.json()).record;
    assert.equal(patch.status, 200);
    assert.equal(edited.capturedAt, earlier.capturedAt);
    assert.equal(edited.uploadedAt, earlier.uploadedAt);
    assert.ok(edited.updatedAt > edited.uploadedAt);
    await setTimeout(10);
    const same = await owner.request(`/api/records/${earlier.id}`, { method: 'PATCH', json: { transcript: '  고친 기록  ' } });
    assert.equal((await same.json()).record.updatedAt, edited.updatedAt);

    const restored = browser(await start(dir));
    assert.equal((await restored.login('b')).status, 200);
    const saved = (await (await restored.request('/api/records')).json()).records.find(record => record.id === earlier.id);
    assert.equal(saved.uploadedAt, earlier.uploadedAt);
    assert.equal(saved.updatedAt, edited.updatedAt);
    const exportText = await restored.request('/api/export?from=2026-11-11&to=2026-11-12&tz=Asia%2FSeoul&format=txt');
    assert.equal(exportText.status, 200);
    const text = await exportText.text();
    assert.ok(text.indexOf('고친 기록') < text.indexOf(later.transcript), 'exports stay in capture chronology after an update');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only the recording author can delete, and tombstones persist without media or transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'our-days-delete-api-'));
  const statePath = join(dir, 'state.json');
  const audioId = randomUUID();
  const pendingId = randomUUID();
  const fileName = `${audioId}.m4a`;
  const mediaPath = join(dir, 'media', fileName);
  const capturedAt = '2026-11-11T16:00:00.000Z';
  const transcript = '이 문장을 지웁니다.';
  try {
    await start(dir, { emptyFamily: false });
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    // Existing data created before deletion support may omit the tombstone map.
    delete state.deletedRecords;
    state.records[audioId] = { id: audioId, authorId: 'family-b', fileName, kind: 'audio', capturedAt,
      mimeType: 'audio/mp4', durationMs: 10000, transcript, transcriptStatus: 'ready' };
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(mediaPath, 'recording fixture');

    const app = await start(dir);
    const author = browser(app);
    const familyOwner = browser(app);
    const anonymous = browser(app);
    assert.equal((await author.login('b')).status, 200);
    assert.equal((await familyOwner.login('a')).status, 200);
    const recordPath = `/api/records/${audioId}`;
    const query = 'from=2026-11-12&to=2026-11-12&tz=Asia%2FSeoul';
    const exportPath = `/api/export?${query}&format=txt`;
    const previous = await familyOwner.request(exportPath);
    assert.equal(previous.status, 200);
    assert.ok((await previous.text()).includes(transcript));
    assert.equal((await anonymous.request(recordPath, { method: 'DELETE' })).status, 401);
    assert.equal((await familyOwner.request(recordPath, { method: 'DELETE' })).status, 403);
    assert.equal((await author.request(recordPath, { method: 'DELETE', headers: { origin: 'https://other.test' } })).status, 403);
    const wrongOwner = await familyOwner.request(recordPath, { method: 'DELETE', headers: { 'x-record-owner': 'family-b' } });
    assert.equal(wrongOwner.status, 409);
    assert.equal((await wrongOwner.json()).code, 'RECORD_OWNER_MISMATCH');
    assert.equal((await familyOwner.request(`${recordPath}/media`)).status, 200);

    assert.equal((await author.request(`/api/records/${audioId.toUpperCase()}`, { method: 'DELETE' })).status, 204);
    assert.equal((await author.request(recordPath, { method: 'DELETE' })).status, 204);
    assert.equal((await familyOwner.request(recordPath, { method: 'DELETE' })).status, 403);
    assert.deepEqual(await (await familyOwner.request('/api/records')).json(), { records: [] });
    assert.equal((await familyOwner.request(`${recordPath}/media`)).status, 404);
    assert.equal((await familyOwner.request(`${recordPath}/audio`)).status, 404);
    assert.equal((await author.request(recordPath, { method: 'PATCH', json: { transcript: '다시 쓰기' } })).status, 404);
    for (const format of ['mp4', 'm4a', 'txt', 'zip']) {
      assert.equal((await familyOwner.request(`/api/export?${query}&format=${format}`)).status, 422);
    }
    assert.equal(existsSync(mediaPath), false);
    assert.equal((await author.request(`/api/records/${pendingId}`, { method: 'DELETE' })).status, 204);
    assert.equal((await familyOwner.request(`/api/records/${pendingId}`, { method: 'DELETE' })).status, 403);
    const saved = await readFile(statePath, 'utf8');
    assert.equal(saved.includes(transcript), false);
    assert.equal(JSON.parse(saved).deletedRecords[audioId], 'family-b');

    // Recover media left by a crash after committing the tombstone and before unlinking.
    await writeFile(mediaPath, 'orphaned recording');
    const restarted = browser(await start(dir));
    assert.equal(existsSync(mediaPath), false);
    assert.equal((await restarted.login('b')).status, 200);
    for (const id of [audioId, pendingId]) {
      const replay = await restarted.request('/api/records', { method: 'POST', body: Buffer.from('late bytes'),
        headers: uploadHeaders({ id, type: 'audio', day: capturedAt, duration: '10000' }, 'family-b') });
      assert.equal(replay.status, 410);
      assert.equal((await replay.json()).code, 'RECORD_DELETED');
    }
    assert.deepEqual(await (await restarted.request('/api/records')).json(), { records: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('short recordings retain measured duration and export without ten-second padding', async (t) => {
  if ([ffmpeg, ffprobe].some((program) => spawnSync(program, ['-version'], { stdio: 'ignore' }).status !== 0)) {
    return t.skip('FFmpeg and FFprobe are required');
  }
  const dir = await mkdtemp(join(tmpdir(), 'our-days-short-audio-'));
  const app = await start(dir, { emptyFamily: false });
  const author = browser(app);
  try {
    assert.equal((await author.login('a')).status, 200);
    const capturedAt = '2026-11-11T16:00:00.000Z';
    const add = async (type, seconds, claimedMs, streaming = false) => {
      const id = randomUUID();
      const file = join(dir, `${id}.${streaming ? 'webm' : type === 'audio' ? 'm4a' : 'mp4'}`);
      makeMediaFixture(file, type, seconds, streaming);
      return author.request('/api/records', { method: 'POST', body: await readFile(file),
        headers: uploadHeaders({ id, type, day: capturedAt, duration: String(claimedMs), mimeType: streaming ? 'audio/webm' : undefined }, 'family-a') });
    };

    const audio = [];
    for (const [seconds, claimedMs, streaming] of [[0.3, 100, false], [1.2, 800, true]]) {
      const response = await add('audio', seconds, claimedMs, streaming);
      assert.equal(response.status, 201);
      const { record } = await response.json();
      assert.ok(Math.abs(record.durationMs - seconds * 1000) < 50, `expected ${seconds}s, got ${record.durationMs}ms`);
      audio.push(record);
      const correction = await author.request(`/api/records/${record.id}`, { method: 'PATCH', json: { transcript: '오늘의 기록.' } });
      assert.equal(correction.status, 200);
    }
    const overLimit = await add('audio', 10.5, 300);
    assert.equal(overLimit.status, 415);
    assert.equal((await overLimit.json()).code, 'BAD_MEDIA');
    assert.equal((await add('video', 3, 3000)).status, 201);

    const query = 'from=2026-11-12&to=2026-11-12&tz=Asia%2FSeoul';
    const exports = [
      { path: `/api/records/${audio[0].id}/audio`, extension: 'm4a', duration: 0.3 },
      { path: `/api/export?${query}&format=m4a`, extension: 'm4a', duration: 1.5 },
      { path: `/api/export?${query}&format=mp4`, extension: 'mp4', duration: 4.5 },
    ];
    for (const [index, { path, extension, duration }] of exports.entries()) {
      const response = await author.request(path);
      assert.equal(response.status, 200);
      const file = join(dir, `export-${index}.${extension}`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
      const actual = Number(probe.stdout.trim());
      assert.ok(Math.abs(actual - duration) < 0.15, `expected ${extension} ${duration}s, got ${actual}s`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('authenticated capture replay, chronology, media and all export formats', async (t) => {
  if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status !== 0) return t.skip('FFmpeg is unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'our-days-media-api-'));
  const app = await start(dir, { emptyFamily: false });
  const owner = browser(app);
  const member = browser(app);
  try {
    assert.equal((await owner.login('a')).status, 200);
    assert.equal((await member.login('b')).status, 200);
    const video = { id: randomUUID(), type: 'video', day: '2026-11-11T16:00:00.000Z', duration: '3000', path: join(dir, 'test.mp4') };
    const audio = { id: randomUUID(), type: 'audio', day: '2026-11-11T15:20:00.000Z', duration: '10000', path: join(dir, 'test.m4a') };
    async function upload(client, fixture, claimedOwner = 'family-a') {
      return client.request('/api/records', { method: 'POST', body: await readFile(fixture.path), headers: uploadHeaders(fixture, claimedOwner) });
    }
    makeMediaFixture(video.path, 'video');
    makeMediaFixture(audio.path, 'audio');
    const wrongAccount = await upload(member, video);
    assert.equal(wrongAccount.status, 409);
    const beforeUpload = Date.now();
    const videoUpload = await upload(owner, video);
    assert.equal(videoUpload.status, 201, await videoUpload.text());
    const replay = await Promise.all([upload(owner, audio), upload(owner, audio)]);
    assert.deepEqual(replay.map(({ status }) => status).sort(), [200, 201]);
    assert.equal((await upload(member, audio, 'family-b')).status, 409);

    const records = (await (await member.request('/api/records')).json()).records;
    assert.deepEqual(records.map(({ id }) => id), [audio.id, video.id]);
    assert.equal(records[0].authorId, 'family-a');
    assert.equal(records[0].capturedAt, audio.day);
    for (const record of records) {
      assert.ok(Date.parse(record.uploadedAt) >= beforeUpload);
      assert.ok(Date.parse(record.uploadedAt) <= Date.now());
      assert.equal(record.updatedAt, record.uploadedAt);
    }
    const replayRecords = await Promise.all(replay.map(response => response.json()));
    assert.equal(replayRecords[0].record.uploadedAt, replayRecords[1].record.uploadedAt);
    assert.equal(replayRecords[0].record.updatedAt, replayRecords[1].record.updatedAt);
    assert.ok(records[0].uploadedAt > records[1].uploadedAt, 'later upload is newer despite its earlier capture date');
    assert.equal((await browser(app).request(records[0].mediaUrl)).status, 401);
    const range = await member.request(records[0].mediaUrl, { headers: { range: 'bytes=4-7' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), 'ftyp');

    const current = async () => (await (await member.request('/api/records')).json()).records[0];
    // Allow the explicit failed marker to land when no speech recognizer is configured.
    for (let attempt = 0; attempt < 30 && (await current()).transcriptStatus === 'processing'; attempt++) await setTimeout(100);
    assert.equal((await current()).updatedAt, records[0].updatedAt, 'background recognition does not reorder the timeline');
    const rangeQuery = 'from=2026-11-12&to=2026-11-12&tz=Asia%2FSeoul';
    if ((await current()).transcriptStatus === 'failed') {
      const failedText = await member.request(`/api/export?${rangeQuery}&format=txt`);
      assert.match(await failedText.text(), /\[인식 실패\]/);
    }
    const fixed = await owner.request(`/api/records/${audio.id}`, { method: 'PATCH', json: { transcript: '오늘 밥을 먹었어요.' } });
    assert.equal(fixed.status, 200);
    assert.equal((await fixed.json()).record.transcriptStatus, 'ready');
    const text = await member.request(`/api/export?${rangeQuery}&format=txt`);
    assert.equal(text.status, 200);
    assert.match(await text.text(), /서연.*오늘 밥을 먹었어요\./s);
    assert.equal((await member.request('/api/export?from=2026-11-12&to=2026-11-12&tz=UTC&format=txt')).status, 422);

    for (const path of [`/api/records/${audio.id}/audio`, `/api/export?${rangeQuery}&format=m4a`, `/api/export?${rangeQuery}&format=mp4`, `/api/export?${rangeQuery}&format=mp4&mode=video`]) {
      const response = await member.request(path);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200, bytes.toString());
      assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    }
    const zip = await member.request(`/api/export?${rangeQuery}&format=zip`);
    const zipBytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(zip.status, 200, zipBytes.toString());
    assert.equal(zipBytes.subarray(0, 4).toString('hex'), '504b0304');
    assert.match(zipBytes.toString('utf8'), /\.mp4/);
    assert.match(zipBytes.toString('utf8'), /\.m4a/);
    assert.match(zipBytes.toString('utf8'), /\.txt/);

    const lateUpload = { ...video, id: randomUUID() };
    const lateBytes = await readFile(video.path);
    const readStarted = Promise.withResolvers();
    const resumeReading = Promise.withResolvers();
    const pausedBody = Readable.from((async function* () {
      readStarted.resolve();
      await resumeReading.promise;
      yield lateBytes;
    })());
    const inFlight = owner.request('/api/records', { method: 'POST', body: pausedBody, headers: uploadHeaders(lateUpload, 'family-a') });
    await readStarted.promise;
    const deleted = await owner.request(`/api/records/${lateUpload.id}`, { method: 'DELETE' });
    resumeReading.resolve();
    assert.equal(deleted.status, 204);
    const rejected = await inFlight;
    assert.equal(rejected.status, 410);
    assert.equal((await rejected.json()).code, 'RECORD_DELETED');
    assert.equal(existsSync(join(dir, 'media', `${lateUpload.id}.media`)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
