import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as media from './media.mjs';
import { createCloudAuth } from './cloud-auth.mjs';
import { createSupabaseRepository } from './supabase.mjs';
import { HttpError, json, noContent, readJson, readBody, checkOrigin, sendFile, sendExport,
  reportError, readRecordHeaders, validSignature, readExportQuery, checkRecordOwner,
  handleStatic, securityHeaders } from './http.mjs';

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const UPLOAD_LIMIT = 16 * 1024 * 1024;
const anonymous = () => ({ user: null, family: null, demo: false, auth: { signup: true, recovery: true }, backend: 'supabase' });
const publicRecord = record => Object.fromEntries([
  'id', 'kind', 'capturedAt', 'uploadedAt', 'updatedAt', 'durationMs', 'authorId', 'authorName',
  'familyId', 'transcript', 'transcriptStatus',
].map(key => [key, record[key]]).concat([['mediaUrl', `/api/records/${record.id}/media`]]));
const chronologically = (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.id.localeCompare(b.id);

function limits(now) {
  const buckets = new Map();
  return (identity, maximum, windowMs = 60000) => {
    const time = now();
    if (buckets.size > 10000) {
      for (const [key, value] of buckets) if (value.until <= time) buckets.delete(key);
      if (buckets.size > 10000) throw new HttpError(429, '요청이 많습니다. 잠시 뒤 다시 시도해 주세요.', 'RATE_LIMIT');
    }
    const key = createHash('sha256').update(identity).digest('hex');
    const previous = buckets.get(key);
    const entry = previous && previous.until > time ? previous : { count: 0, until: time + windowMs };
    entry.count++;
    buckets.set(key, entry);
    if (entry.count > maximum) throw new HttpError(429, '요청이 많습니다. 잠시 뒤 다시 시도해 주세요.', 'RATE_LIMIT');
  };
}

function closedRecord(record) {
  if (!record || record.status !== 'ready') throw new HttpError(404, '기록을 찾을 수 없어요.', 'RECORD_NOT_FOUND');
  return record;
}

function mediaRecord(record, path) {
  return { ...record, path,
    transcript: record.kind === 'audio' ? { status: record.transcriptStatus, text: record.transcript } : undefined };
}

async function removeScratch(directory, prefix) {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(prefix)) {
    throw new Error('Refusing to remove an unexpected temporary directory.');
  }
  await rm(target, { recursive: true, force: true });
}

export async function createCloudApp({ config, tls, repository, fetchImpl = fetch, mediaImpl = media, now = Date.now } = {}) {
  if (!config?.supabaseUrl || !config?.supabaseKey) throw new Error('Supabase configuration is required.');
  const source = repository || createSupabaseRepository({ url: config.supabaseUrl, key: config.supabaseKey, fetchImpl });
  const auth = createCloudAuth({ url: config.supabaseUrl, key: config.supabaseKey, secret: config.sessionSecret,
    origin: config.origin, secureCookie: config.secureCookie, fetchImpl, now });
  const guard = limits(now);
  const activeTranscripts = new Set();
  const activeExports = new Set();
  let activeUploads = 0;
  let activeReads = 0;
  const maxRecords = Math.max(1, Math.min(Number(config.maxExportRecords) || 100, 200));
  const maxBytes = Math.max(UPLOAD_LIMIT, Math.min(Number(config.maxExportBytes) || 128 * 1024 * 1024, 256 * 1024 * 1024));

  async function sessionView(login, repo) {
    if (!login) return anonymous();
    return { ...await repo.session(login.user), demo: false, auth: { signup: true, recovery: true },
      backend: 'supabase', recovery: login.recovery === true };
  }

  async function withFiles(records, repo, task) {
    if (records.length > maxRecords) throw new HttpError(422, `한 번에 ${maxRecords}개까지 내보낼 수 있어요. 기간을 줄여 주세요.`, 'EXPORT_TOO_LARGE');
    const directory = await mkdtemp(join(tmpdir(), 'still-cloud-'));
    let total = 0;
    try {
      const local = [];
      for (const [index, record] of records.entries()) {
        closedRecord(await repo.getRecord(record.id));
        const bytes = await repo.readObject(record);
        total += bytes.length;
        if (bytes.length > UPLOAD_LIMIT || total > maxBytes) throw new HttpError(422, '내보낼 파일이 너무 큽니다. 기간을 줄여 주세요.', 'EXPORT_TOO_LARGE');
        const path = join(directory, `${index}.media`);
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        local.push(mediaRecord(record, path));
      }
      return await task(local);
    } finally { await removeScratch(directory, 'still-cloud-'); }
  }

  function scheduleTranscription(record, repo) {
    if (record.kind !== 'audio' || record.transcriptStatus !== 'processing' || activeTranscripts.size >= 1 || activeTranscripts.has(record.id)) return;
    activeTranscripts.add(record.id);
    void withFiles([record], repo, async ([local]) => {
      let result;
      try { result = await mediaImpl.transcribeAudio(local.path); }
      catch { result = { status: 'failed', text: '' }; }
      const current = await repo.getRecord(record.id);
      if (!current || current.status !== 'ready' || current.transcriptStatus !== 'processing') return;
      await repo.setTranscript(record.id, result.status === 'ready' && result.text?.trim() ? result.text.trim() : null, { automatic: true });
    }).catch(() => {
      // A transient backend/auth failure stays processing and is retried on the next record list.
    }).finally(() => activeTranscripts.delete(record.id));
  }

  async function requireUnchanged(records, repo) {
    for (const record of records) {
      const current = await repo.getRecord(record.id);
      if (!current || current.status !== 'ready') throw new HttpError(409, '처리 중 기록이 삭제됐어요. 다시 시도해 주세요.', 'EXPORT_RECORDS_CHANGED');
    }
  }

  async function exportRecords(request, response, repo, login, query, individual) {
    guard('export:' + login.user.id, 8);
    if (activeExports.size >= 2 || activeExports.has(login.user.id)) throw new HttpError(429, '파일을 만들고 있습니다. 잠시 뒤 다시 시도해 주세요.', 'EXPORT_BUSY');
    activeExports.add(login.user.id);
    try {
      const records = individual ? [individual] : (await repo.listRecords()).filter(record => {
        const day = query.dayInZone(record.capturedAt);
        return day >= query.from && day <= query.to
          && (!['m4a', 'txt'].includes(query.format) || record.kind === 'audio')
          && !(query.format === 'mp4' && query.mode === 'video' && record.kind !== 'video');
      }).sort(chronologically);
      if (!records.length) throw new HttpError(422, '선택한 기간에 기록이 없어요.', 'EMPTY_EXPORT');
      if (records.length > maxRecords) throw new HttpError(422, `한 번에 ${maxRecords}개까지 내보낼 수 있어요. 기간을 줄여 주세요.`, 'EXPORT_TOO_LARGE');
      const render = local => individual ? mediaImpl.renderIndividualAudio(local[0])
        : mediaImpl.renderArchive(local, { format: query.format, includeAudio: query.mode === 'mixed', timeZone: query.timeZone });
      const output = query.format === 'txt'
        ? await render(records.map(record => mediaRecord(record, '')))
        : await withFiles(records, repo, render);
      await requireUnchanged(records, repo);
      const filename = individual ? `Still-${individual.capturedAt.slice(0, 10)}-${individual.id.slice(0, 8)}.m4a`
        : `Still-${query.from}-${query.to}.${output.extension}`;
      return sendExport(response, output, filename, !individual && query.inline && query.format === 'mp4', request.headers.range);
    } finally { activeExports.delete(login.user.id); }
  }

  async function addRecord(request, response, repo, login) {
    checkRecordOwner(request, login.user);
    guard('upload:' + login.user.id, 30);
    if (activeUploads >= 4) {
      request.resume();
      throw new HttpError(429, '업로드 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.', 'UPLOAD_BUSY');
    }
    activeUploads++;
    let directory;
    try {
      const info = readRecordHeaders(request);
      const bytes = await readBody(request, UPLOAD_LIMIT);
      if (!validSignature(bytes, info.mimeType)) throw new HttpError(415, '촬영·녹음 파일을 읽을 수 없어요.', 'BAD_MEDIA');
      directory = await mkdtemp(join(tmpdir(), 'still-upload-'));
      const path = join(directory, 'recording.media');
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      const measured = await mediaImpl.validateMedia(path, info.kind);
      const reservation = await repo.reserveRecord({ ...info, mimeType: measured.mimeType || info.mimeType,
        durationMs: measured.durationMs || info.durationMs, sizeBytes: bytes.length });
      if (reservation.status === 'ready') {
        scheduleTranscription(reservation, repo);
        return json(response, { record: publicRecord(reservation) });
      }
      if (reservation.status !== 'pending') throw new HttpError(410, '이미 삭제된 기록이에요.', 'RECORD_DELETED');
      let record;
      try {
        await repo.putObject(reservation, bytes);
        // A retry may reuse a previously uploaded immutable object. Validate what will actually be shared.
        const actual = await repo.readObject(reservation);
        if (actual.length !== bytes.length || !actual.equals(bytes)) throw new HttpError(409, '다른 내용의 기록이 같은 번호로 저장되어 있어요.', 'RECORD_CONFLICT');
        record = await repo.finishRecord(info.id);
      } catch (error) {
        // Deletion may win between object upload and metadata finalization. Remove that object's residue.
        const current = await repo.getRecord(info.id).catch(() => undefined);
        if (current === null) await repo.removeObject(reservation).catch(() => {});
        throw error;
      }
      scheduleTranscription(record, repo);
      return json(response, { record: publicRecord(record) }, 201);
    } finally {
      activeUploads--;
      if (directory) await removeScratch(directory, 'still-upload-');
    }
  }

  async function route(request, response) {
    securityHeaders(response);
    response.setHeader('Cache-Control', 'no-store');
    if (config.secureCookie) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    const method = request.method;
    if (pathname === '/api/health' && method === 'GET') return json(response, { status: 'ok', backend: 'supabase' });
    if (await handleStatic(request, response)) return;
    // API reads include private media and expensive exports; reject cross-site navigations too.
    if (pathname.startsWith('/api/')) checkOrigin(request, config.origin);
    if (pathname === '/auth/confirm' && method === 'GET') {
      guard('confirm:' + (request.socket.remoteAddress || ''), 30);
      try {
        await auth.confirm(response, searchParams.get('token_hash'), searchParams.get('type'));
        response.writeHead(303, { Location: '/#timeline', 'Cache-Control': 'no-store' });
      } catch {
        response.writeHead(303, { Location: '/?auth_error=expired#timeline', 'Cache-Control': 'no-store' });
      }
      response.end();
      return;
    }
    if (['/api/login', '/api/signup', '/api/password/reset'].includes(pathname) && method === 'POST') {
      guard('auth-ip:' + (request.socket.remoteAddress || ''), 30);
      const body = await readJson(request);
      if (typeof body.email === 'string') guard('auth-email:' + body.email.trim().toLowerCase(), 8);
      if (pathname === '/api/password/reset') {
        await auth.reset(body.email);
        return json(response, { message: '등록된 이메일이면 비밀번호 재설정 안내를 보냈습니다.' });
      }
      const login = pathname === '/api/login'
        ? await auth.login(response, body.email, body.password) : await auth.signup(response, body);
      if (!login) return json(response, { confirmationRequired: true, message: '메일함에서 이메일 확인을 마친 뒤 로그인해 주세요. 이미 가입했다면 로그인하거나 비밀번호를 재설정할 수 있습니다.' });
      return json(response, await sessionView(login, source.forUser(login.accessToken)));
    }
    if (pathname === '/api/logout' && method === 'POST') {
      await auth.logoutRequest(request, response);
      return noContent(response);
    }
    const login = await auth.current(request, response);
    const repo = login && source.forUser(login.accessToken);
    if (pathname === '/api/session' && method === 'GET') return json(response, await sessionView(login, repo));
    if (!login) throw new HttpError(401, '로그인해 주세요.', 'SIGN_IN_REQUIRED');
    if (pathname === '/api/password/update' && method === 'POST') {
      guard('password:' + login.user.id, 5);
      if (!login.recovery) throw new HttpError(403, '이메일의 비밀번호 재설정 링크로 다시 접속해 주세요.', 'RECOVERY_REQUIRED');
      const body = await readJson(request);
      const updated = await auth.updatePassword(response, login, body.password);
      return json(response, await sessionView(updated, repo));
    }
    if (pathname === '/api/family' && method === 'POST') {
      guard('family:' + login.user.id, 5);
      const { name } = await readJson(request);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new HttpError(400, '기록 공간 이름을 1~60자로 입력해 주세요.');
      await repo.createFamily(name.trim());
      return json(response, await sessionView(login, repo), 201);
    }
    if (pathname === '/api/invite/accept' && method === 'POST') {
      guard('invite:' + login.user.id, 10);
      const { code } = await readJson(request);
      if (typeof code !== 'string' || !/^[a-z\d-]{12,80}$/i.test(code.trim())) throw new HttpError(400, '초대 코드를 확인해 주세요.', 'INVALID_INVITE');
      await repo.joinFamily(code.trim());
      return json(response, await sessionView(login, repo));
    }
    const view = await repo.session(login.user);
    if (!view.family) throw new HttpError(403, '기록 공간에 먼저 가입해 주세요.', 'FAMILY_REQUIRED');
    if (pathname === '/api/invite/rotate' && method === 'POST') {
      guard('invite-rotate:' + login.user.id, 5);
      await repo.rotateInvite();
      return json(response, await sessionView(login, repo));
    }
    if (pathname === '/api/records') {
      if (method === 'GET') {
        const records = await repo.listRecords();
        for (const record of records) scheduleTranscription(record, repo);
        return json(response, { records: records.map(publicRecord) });
      }
      if (method === 'POST') return addRecord(request, response, repo, login);
    }
    const matched = /^\/api\/records\/([a-f\d-]+)(?:\/(media|audio))?$/i.exec(pathname);
    if (matched && uuid.test(matched[1])) {
      const id = matched[1].toLowerCase();
      const action = matched[2];
      if (!action && method === 'DELETE') {
        checkRecordOwner(request, login.user);
        const removed = await repo.deleteRecord(id);
        if (removed) await repo.removeObject(removed);
        return noContent(response);
      }
      const record = closedRecord(await repo.getRecord(id));
      if (action === 'media' && ['GET', 'HEAD'].includes(method)) {
        if (activeReads >= 8) throw new HttpError(429, '재생 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.', 'MEDIA_BUSY');
        activeReads++;
        try {
          return await withFiles([record], repo, async ([local]) => {
            await requireUnchanged([record], repo);
            return sendFile(request, response, local.path, record.mimeType, { cache: 'no-store', range: true });
          });
        } finally { activeReads--; }
      }
      if (action === 'audio' && method === 'GET' && record.kind === 'audio') {
        return exportRecords(request, response, repo, login, { format: 'm4a' }, record);
      }
      if (!action && method === 'PATCH' && record.kind === 'audio') {
        const body = await readJson(request);
        if (typeof body.transcript !== 'string' || !body.transcript.trim() || body.transcript.trim().length > 5000) {
          throw new HttpError(400, '녹음 내용을 1~5,000자로 입력해 주세요.');
        }
        return json(response, { record: publicRecord(await repo.setTranscript(id, body.transcript.trim())) });
      }
    }
    if (pathname === '/api/export' && method === 'GET') return exportRecords(request, response, repo, login, readExportQuery(searchParams));
    if (pathname === '/api/home') {
      if (method === 'GET') return json(response, { home: await repo.getHome() });
      if (method === 'PUT') {
        const { address } = await readJson(request);
        if (typeof address !== 'string' || !address.trim() || address.trim().length > 200) throw new HttpError(400, '상세 주소를 1~200자로 입력해 주세요.');
        return json(response, { home: await repo.updateHome(address.trim()) });
      }
    }
    throw new HttpError(404, '요청한 페이지를 찾을 수 없어요.');
  }

  const handleRequest = (request, response) => { void route(request, response).catch(error => reportError(response, error)); };
  const app = tls ? createSecureServer(tls, handleRequest) : createServer(handleRequest);
  app.requestTimeout = 60000;
  app.headersTimeout = 15000;
  app.keepAliveTimeout = 5000;
  return app;
}
