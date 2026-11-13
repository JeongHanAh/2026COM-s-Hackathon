import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { demoHome, viewHome } from './home.mjs';
import * as media from './media.mjs';

const serverDir = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(serverDir);
const publicDir = join(projectDir, 'public');
const sessionCookie = 'ourd_session';
const sessionAgeSeconds = 60 * 60 * 24 * 30;
const uploadLimit = 16 * 1024 * 1024;
const recordIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const capturedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const audioMimeTypes = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-m4a']);
const videoMimeTypes = new Set(['video/webm', 'video/mp4', 'video/ogg', 'video/quicktime']);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4a': 'audio/mp4',
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function passwordDigest(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function checkPassword(password, credentials) {
  const { hash } = passwordDigest(password, credentials.salt);
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(credentials.hash, 'hex'));
}

function tokenKey(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sessionToken(request) {
  return /(?:^|;\s*)ourd_session=([a-f\d]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
}

function setSessionCookie(request, response, token) {
  const secure = request.socket.encrypted || process.env.OURDAYS_SECURE_COOKIE === '1';
  const age = token ? sessionAgeSeconds : 0;
  response.setHeader('Set-Cookie', `${sessionCookie}=${token || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`);
}

function json(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function noContent(response) {
  response.writeHead(204, { 'Cache-Control': 'no-store' });
  response.end();
}

async function readBody(request, limit) {
  const declaredLength = Number(request.headers['content-length']);
  if (declaredLength > limit) {
    request.resume();
    throw new HttpError(413, '파일 크기 제한을 넘었어요.');
  }
  const chunks = [];
  let size = 0;
  // Drain an oversized request without destroying the HTTP response socket.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, '파일 크기 제한을 넘었어요.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const bytes = await readBody(request, 32 * 1024);
  try {
    const data = JSON.parse(bytes.toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Invalid JSON and non-object values use the same response.
  }
  throw new HttpError(400, '요청 형식을 확인해 주세요.');
}

function checkOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, '이 요청을 허용할 수 없어요.');
  }
  const origin = request.headers.origin;
  if (!origin) return;
  const expected = process.env.OURDAYS_ORIGIN || `${request.socket.encrypted || process.env.OURDAYS_SECURE_COOKIE === '1' ? 'https' : 'http'}://${request.headers.host}`;
  if (origin !== expected) throw new HttpError(403, '이 요청을 허용할 수 없어요.');
}

async function writeState(statePath, state) {
  const tempPath = `${statePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(state), { flag: 'wx', mode: 0o600, flush: true });
    await rename(tempPath, statePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function makeFamily(name, ownerId, members = [ownerId]) {
  return { id: randomUUID(), name, ownerId, members, inviteCode: randomBytes(6).toString('hex').toUpperCase() };
}

async function seedDemoRecords(state, mediaDir) {
  const fixtureDir = join(serverDir, 'demo');
  let fixture;
  try {
    fixture = JSON.parse(await readFile(join(fixtureDir, 'records.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const [index, entry] of fixture.entries()) {
    const file = basename(entry.file);
    const id = entry.id || `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const fileName = `${id}${extname(file).toLowerCase()}`;
    await copyFile(join(fixtureDir, file), join(mediaDir, fileName));
    state.records[id] = {
      id, fileName, authorId: entry.authorId, kind: entry.kind,
      capturedAt: new Date(entry.capturedAt ?? Date.now() - entry.hoursAgo * 3600000).toISOString(),
      mimeType: entry.mimeType, durationMs: entry.durationMs,
      transcript: entry.transcript ?? null,
      transcriptStatus: entry.kind === 'audio' ? (entry.transcript ? 'ready' : 'processing') : null,
    };
  }
}

async function loadState({ dataDir, mediaDir, demo, emptyFamily }) {
  const statePath = join(dataDir, 'state.json');
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const users = {
      'family-a': { id: 'family-a', name: '서연', email: 'family-a@example.test', credentials: passwordDigest(process.env.OURDAYS_PASSWORD_A || 'demo2026!') },
      'family-b': { id: 'family-b', name: '지우', email: 'family-b@example.test', credentials: passwordDigest(process.env.OURDAYS_PASSWORD_B || 'demo2026!') },
    };
    const family = emptyFamily ? null : makeFamily('우리 가족', 'family-a', ['family-a', 'family-b']);
    const home = family ? { ...structuredClone(demoHome), address: demo ? demoHome.address : '' } : null;
    state = { users, sessions: {}, family, records: {}, deletedRecords: {}, home };
    if (demo && family) await seedDemoRecords(state, mediaDir);
    await writeState(statePath, state);
  }
  state.deletedRecords ??= {};
  return { state, statePath };
}

function isMember(state, userId) {
  return Boolean(state.family?.members.includes(userId));
}

function userRole(family, userId) {
  return family?.ownerId === userId ? 'owner' : 'member';
}

function sessionView(state, user, demo) {
  if (!user) return { user: null, family: null, demo };
  const member = isMember(state, user.id);
  const userView = { id: user.id, name: user.name, role: member ? userRole(state.family, user.id) : null, member };
  if (!member) return { user: userView, family: null, demo };
  const family = state.family;
  const familyView = {
    id: family.id,
    name: family.name,
    members: family.members.map((id) => ({ id, name: state.users[id].name, role: userRole(family, id) })),
  };
  if (family.ownerId === user.id && family.members.length < 2) familyView.inviteCode = family.inviteCode;
  return { user: userView, family: familyView, demo };
}

function recordView(state, record) {
  const { id, kind, capturedAt, durationMs, authorId, transcript, transcriptStatus } = record;
  return { id, kind, capturedAt, durationMs, authorId, authorName: state.users[authorId].name,
    mediaUrl: `/api/records/${id}/media`, transcript, transcriptStatus };
}

function recordCompare(first, second) {
  return first.capturedAt.localeCompare(second.capturedAt) || first.id.localeCompare(second.id);
}

function mediaRecord(state, record, mediaDir) {
  return { ...recordView(state, record), path: join(mediaDir, record.fileName), mimeType: record.mimeType,
    transcript: record.kind === 'audio' ? { status: record.transcriptStatus, text: record.transcript } : undefined };
}

function readRecordHeaders(request) {
  const id = request.headers['x-record-id']?.toLowerCase();
  const kind = request.headers['x-record-kind'];
  const capturedAt = request.headers['x-captured-at'];
  const durationMs = Number(request.headers['x-duration-ms']);
  const limits = media.recordingLimits[kind];
  const mimeType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!id || !recordIdPattern.test(id) || !['audio', 'video'].includes(kind)
    || !capturedAt || !capturedAtPattern.test(capturedAt) || !validDay(capturedAt.slice(0, 10)) || !Number.isFinite(Date.parse(capturedAt))
    || !Number.isFinite(durationMs) || durationMs < (kind === 'video' ? limits.maxMs - 1500 : limits.minMs)
    || durationMs > limits.maxMs + (kind === 'video' ? 2000 : limits.toleranceMs)) {
    throw new HttpError(400, '기록 정보가 올바르지 않아요.', 'BAD_RECORD');
  }
  if (!(kind === 'video' ? videoMimeTypes : audioMimeTypes).has(mimeType)) {
    throw new HttpError(415, '지원하는 녹음·촬영 형식을 확인해 주세요.', 'BAD_MEDIA');
  }
  return { id, kind, capturedAt: new Date(capturedAt).toISOString(), durationMs: Math.round(durationMs), mimeType };
}

function checkRecordOwner(request, user) {
  const owner = request.headers['x-record-owner'] || request.headers['x-author-id'];
  if (owner && owner !== user.id) {
    request.resume();
    throw new HttpError(409, '기록을 남긴 계정으로 로그인해 주세요.', 'RECORD_OWNER_MISMATCH');
  }
}

function rejectDeletedUpload(state, id) {
  if (state.deletedRecords[id]) throw new HttpError(410, '이미 삭제된 기록이에요.', 'RECORD_DELETED');
}

async function removeMediaFile(path) {
  // A converter can hold the source briefly on Windows. Retry sharing violations.
  for (const retryDelay of [0, 50, 100, 250, 500, 1000]) {
    if (retryDelay) await delay(retryDelay);
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code) || retryDelay === 1000) throw error;
    }
  }
}

async function clearDeletedMedia(mediaDir, matchesRecordId) {
  const files = await readdir(mediaDir, { withFileTypes: true });
  for (const file of files) {
    const id = file.name.split('.')[0];
    if (file.isFile() && recordIdPattern.test(id) && matchesRecordId(id)) {
      await removeMediaFile(join(mediaDir, file.name));
    }
  }
}

function validSignature(bytes, mimeType) {
  if (mimeType.endsWith('/webm')) return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType.endsWith('/ogg')) return bytes.toString('ascii', 0, 4) === 'OggS';
  if (/\/(mp4|x-m4a|quicktime)$/.test(mimeType)) return bytes.toString('ascii', 4, 8) === 'ftyp';
  if (mimeType === 'audio/wav') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  return mimeType === 'audio/mpeg' && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0));
}

function contentDisposition(filename, inline) {
  return `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.\-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? { start, end } : null;
}

async function sendFile(request, response, filePath, type, { cache = 'no-cache', range = false, beforeHeaders } = {}) {
  let details;
  try {
    details = await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, '파일을 찾을 수 없어요.');
    throw error;
  }
  if (!details.isFile()) throw new HttpError(404, '파일을 찾을 수 없어요.');
  beforeHeaders?.();
  const headers = { 'Content-Type': type, 'Content-Length': details.size, 'Cache-Control': cache };
  let partial;
  if (range) headers['Accept-Ranges'] = 'bytes';
  if (range && request.headers.range) {
    partial = byteRange(request.headers.range, details.size);
    if (!partial) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${details.size}`, 'Content-Length': 0 });
      response.end();
      return;
    }
    headers['Content-Range'] = `bytes ${partial.start}-${partial.end}/${details.size}`;
    headers['Content-Length'] = partial.end - partial.start + 1;
  }
  response.writeHead(partial ? 206 : 200, headers);
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(filePath, partial), response);
}

function validDay(value) {
  if (!value || !dayPattern.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value;
}

function readExportQuery(params) {
  const from = params.get('from');
  const to = params.get('to');
  const format = params.get('format');
  const mode = params.get('mode') || 'mixed';
  const timeZone = params.get('tz') || 'Asia/Seoul';
  if (!validDay(from) || !validDay(to) || from > to || !['mp4', 'm4a', 'txt', 'zip'].includes(format)
    || !['mixed', 'video'].includes(mode) || timeZone.length > 100) {
    throw new HttpError(400, '내보낼 기간과 파일 형식을 확인해 주세요.');
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new HttpError(400, '시간대가 올바르지 않아요.');
  }
  const dayInZone = (capturedAt) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(capturedAt)).map(({ type, value }) => [type, value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  };
  return { from, to, format, mode, timeZone, dayInZone, inline: params.get('inline') === '1' };
}

function sendExport(response, output, filename, inline = false, range) {
  const { data, contentType } = output;
  const headers = { 'Content-Type': contentType, 'Content-Length': data.length,
    'Content-Disposition': contentDisposition(filename, inline), 'Cache-Control': 'no-store' };
  if (inline) headers['Accept-Ranges'] = 'bytes';
  if (inline && range) {
    const part = byteRange(range, data.length);
    if (!part) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${data.length}`, 'Content-Length': 0 });
      response.end();
      return;
    }
    headers['Content-Range'] = `bytes ${part.start}-${part.end}/${data.length}`;
    headers['Content-Length'] = part.end - part.start + 1;
    response.writeHead(206, headers);
    response.end(data.subarray(part.start, part.end + 1));
    return;
  }
  response.writeHead(200, headers);
  response.end(data);
}

function reportError(response, error) {
  if (response.destroyed || response.headersSent) return;
  if (error instanceof HttpError) return json(response, { error: error.message, code: error.code }, error.status);
  const knownErrors = {
    EMPTY_EXPORT: [422, '이 형식으로 내보낼 기록이 없어요.'],
    BAD_MEDIA: [415, '촬영·녹음 파일을 읽을 수 없어요.'],
    MEDIA_UNAVAILABLE: [503, '서버의 미디어 처리 도구를 사용할 수 없어요.'],
    MEDIA_FAILED: [422, '파일을 처리하지 못했어요.'],
  };
  if (Object.hasOwn(knownErrors, error.code)) {
    const [status, message] = knownErrors[error.code];
    return json(response, { error: message, code: error.code }, status);
  }
  console.error(error.message);
  return json(response, { error: '서버에서 오류가 발생했어요.' }, 500);
}

export async function createApp({
  dataDir = process.env.OURDAYS_DATA_DIR || join(projectDir, 'data'),
  demo = process.env.OURDAYS_DEMO !== '0',
  emptyFamily = process.env.OURDAYS_EMPTY_FAMILY === '1',
  tls,
} = {}) {
  const mediaDir = join(resolve(dataDir), 'media');
  const loaded = await loadState({ dataDir: resolve(dataDir), mediaDir, demo, emptyFamily });
  let state = loaded.state;
  let mutation = Promise.resolve();
  const activeTranscripts = new Set();
  const loginAttempts = new Map();
  const dummyCredentials = passwordDigest(randomUUID());

  // A durable deletion also covers interruption between the state commit and unlink.
  if (Object.keys(state.deletedRecords).length) {
    await clearDeletedMedia(mediaDir, (id) => Boolean(state.deletedRecords[id])).catch((error) => {
      console.error('Deleted media cleanup could not finish:', error.code);
    });
  }

  // All commits use an atomic replacement and are ordered across simultaneous requests.
  function mutate(change) {
    const operation = mutation.then(async () => {
      const draft = structuredClone(state);
      const result = await change(draft);
      await writeState(loaded.statePath, draft);
      state = draft;
      return result;
    });
    mutation = operation.catch(() => {});
    return operation;
  }

  function scheduleTranscription(record) {
    if (state.records[record.id]?.transcriptStatus !== 'processing' || activeTranscripts.has(record.id)) return;
    activeTranscripts.add(record.id);
    void (async () => {
      let result;
      try {
        result = await media.transcribeAudio(join(mediaDir, record.fileName));
      } catch {
        result = { status: 'failed', text: '' };
      }
      if (state.records[record.id]?.transcriptStatus !== 'processing') return;
      await mutate((draft) => {
        const stored = draft.records[record.id];
        if (stored?.transcriptStatus !== 'processing') return;
        stored.transcriptStatus = result.status === 'ready' && result.text?.trim() ? 'ready' : 'failed';
        stored.transcript = stored.transcriptStatus === 'ready' ? result.text.trim() : null;
      });
    })().catch((error) => console.error(error.message)).finally(() => activeTranscripts.delete(record.id));
  }

  async function deleteRecord(id, user) {
    await mutate((draft) => {
      const authorId = draft.records[id]?.authorId ?? draft.deletedRecords[id];
      if (authorId && authorId !== user.id) {
        throw new HttpError(403, '기록을 남긴 사람만 삭제할 수 있습니다.', 'RECORD_DELETE_FORBIDDEN');
      }
      draft.deletedRecords[id] = user.id;
      delete draft.records[id];
    });
    try {
      await clearDeletedMedia(mediaDir, (recordId) => recordId === id);
    } catch (error) {
      console.error('Deleted media cleanup could not finish:', error.code);
      throw new HttpError(500, '기록 파일을 정리하지 못했어요. 다시 시도해 주세요.', 'MEDIA_DELETE_FAILED');
    }
  }

  async function addRecord(request, user) {
    checkRecordOwner(request, user);
    const info = readRecordHeaders(request);
    if (state.deletedRecords[info.id]) request.resume();
    rejectDeletedUpload(state, info.id);
    const duplicate = state.records[info.id];
    if (duplicate) {
      request.resume();
      if (duplicate.authorId === user.id) return { record: duplicate, created: false };
      throw new HttpError(409, '이미 사용된 기록 번호예요.', 'RECORD_CONFLICT');
    }
    const bytes = await readBody(request, uploadLimit);
    if (!validSignature(bytes, info.mimeType)) throw new HttpError(415, '촬영·녹음 파일을 읽을 수 없어요.', 'BAD_MEDIA');
    const uploadPath = join(mediaDir, `${randomUUID()}.upload`);
    const fileName = `${info.id}.media`;
    const finalPath = join(mediaDir, fileName);
    let moved = false;
    try {
      await writeFile(uploadPath, bytes, { flag: 'wx', mode: 0o600, flush: true });
      let observed = {};
      try {
        observed = await media.validateMedia(uploadPath, info.kind);
      } catch (error) {
        if (info.kind === 'audio' || error.code !== 'MEDIA_UNAVAILABLE') throw error;
      }
      const result = await mutate(async (draft) => {
        rejectDeletedUpload(draft, info.id);
        const existing = draft.records[info.id];
        if (existing) {
          if (existing.authorId === user.id) return { record: existing, created: false };
          throw new HttpError(409, '이미 사용된 기록 번호예요.', 'RECORD_CONFLICT');
        }
        const stored = { id: info.id, fileName, kind: info.kind, capturedAt: info.capturedAt,
          mimeType: observed.mimeType || info.mimeType, durationMs: observed.durationMs || info.durationMs,
          authorId: user.id, transcript: null, transcriptStatus: info.kind === 'audio' ? 'processing' : null };
        await rename(uploadPath, finalPath);
        moved = true;
        draft.records[info.id] = stored;
        return { record: stored, created: true };
      });
      scheduleTranscription(result.record);
      return result;
    } catch (error) {
      // Keep an orphaned media file after an interrupted commit. The next retry replaces it.
      if (moved) console.error(`Record commit failed for ${info.id}`);
      throw error;
    } finally {
      await rm(uploadPath, { force: true });
    }
  }

  async function route(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    const method = request.method;
    if (!pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, '지원하지 않는 요청이에요.');
      const target = resolve(publicDir, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
      if (!target.startsWith(`${publicDir}${sep}`)) throw new HttpError(404, '페이지를 찾을 수 없어요.');
      const type = mimeTypes[extname(target).toLowerCase()];
      if (!type) throw new HttpError(404, '파일을 찾을 수 없어요.');
      return sendFile(request, response, target, type, { range: /^(video|audio)\//.test(type) });
    }

    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(method)) checkOrigin(request);
    const token = sessionToken(request);
    const key = token ? tokenKey(token) : null;
    const session = key && state.sessions[key];
    const user = session && session.expiresAt > Date.now() ? state.users[session.userId] : null;
    if (method === 'GET' && pathname === '/api/session') return json(response, sessionView(state, user, demo));

    if (method === 'POST' && pathname === '/api/login') {
      const address = request.socket.remoteAddress || '';
      const now = Date.now();
      const previous = loginAttempts.get(address);
      if (previous && previous.until > now && previous.count >= 8) {
        throw new HttpError(429, '잠시 뒤 로그인해 주세요.');
      }
      const { email, password } = await readJson(request);
      const account = typeof email === 'string' && Object.values(state.users).find((item) => item.email === email.trim().toLowerCase());
      const valid = typeof password === 'string' && password.length <= 256 && checkPassword(password, account ? account.credentials : dummyCredentials);
      if (!valid || !account) {
        const count = previous && previous.until > now ? previous.count + 1 : 1;
        loginAttempts.set(address, { until: now + 60_000, count });
        throw new HttpError(401, '이메일 또는 비밀번호를 확인해 주세요.');
      }
      loginAttempts.delete(address);
      const newToken = randomBytes(32).toString('hex');
      await mutate((draft) => {
        for (const [sessionKey, entry] of Object.entries(draft.sessions)) {
          if (entry.expiresAt <= now || sessionKey === key) delete draft.sessions[sessionKey];
        }
        draft.sessions[tokenKey(newToken)] = { userId: account.id, expiresAt: now + sessionAgeSeconds * 1000 };
      });
      setSessionCookie(request, response, newToken);
      return json(response, sessionView(state, account, demo));
    }

    if (method === 'POST' && pathname === '/api/logout') {
      if (key && state.sessions[key]) await mutate((draft) => { delete draft.sessions[key]; });
      setSessionCookie(request, response, null);
      return noContent(response);
    }

    if (!user) throw new HttpError(401, '로그인해 주세요.', 'SIGN_IN_REQUIRED');
    if (method === 'POST' && pathname === '/api/family') {
      const body = await readJson(request);
      const name = typeof body.name === 'string' && body.name.trim();
      if (!name || name.length > 60) throw new HttpError(400, '기록 공간 이름을 1~60자로 입력해 주세요.');
      await mutate((draft) => {
        if (draft.family) throw new HttpError(409, '이미 기록 공간이 있습니다. 초대 코드를 확인해 주세요.');
        draft.family = makeFamily(name, user.id);
        draft.home = { ...structuredClone(demoHome), ownerId: user.id, address: '' };
      });
      return json(response, sessionView(state, user, demo), 201);
    }

    if (method === 'POST' && pathname === '/api/invite/accept') {
      const body = await readJson(request);
      const code = typeof body.code === 'string' && body.code.trim().toUpperCase();
      await mutate((draft) => {
        if (!draft.family || !code || code !== draft.family.inviteCode) throw new HttpError(400, '초대 코드를 확인해 주세요.');
        if (isMember(draft, user.id)) return;
        if (draft.family.members.length >= 2) throw new HttpError(409, '이 기록 공간에는 이미 두 명이 가입했습니다.');
        draft.family.members.push(user.id);
      });
      return json(response, sessionView(state, user, demo));
    }

    if (!isMember(state, user.id)) throw new HttpError(403, '기록 공간에 먼저 가입해 주세요.', 'FAMILY_REQUIRED');
    if (pathname === '/api/records') {
      if (method === 'GET') return json(response, { records: Object.values(state.records).sort(recordCompare).map((record) => recordView(state, record)) });
      if (method === 'POST') {
        const { record, created } = await addRecord(request, user);
        return json(response, { record: recordView(state, record) }, created ? 201 : 200);
      }
    }

    const recordRoute = /^\/api\/records\/([\da-f-]+)(?:\/(media|audio))?$/i.exec(pathname);
    if (recordRoute && recordIdPattern.test(recordRoute[1])) {
      const [, rawId, action] = recordRoute;
      const id = rawId.toLowerCase();
      if (!action && method === 'DELETE') {
        checkRecordOwner(request, user);
        await deleteRecord(id, user);
        return noContent(response);
      }
      const record = state.records[id];
      if (!record) throw new HttpError(404, '기록을 찾을 수 없어요.');
      const checkRecordStillExists = () => {
        if (!state.records[id]) throw new HttpError(404, '기록을 찾을 수 없어요.');
      };
      if (action === 'media' && ['GET', 'HEAD'].includes(method)) {
        return sendFile(request, response, join(mediaDir, record.fileName), record.mimeType, {
          cache: 'no-store', range: true, beforeHeaders: checkRecordStillExists,
        });
      }
      if (action === 'audio' && method === 'GET' && record.kind === 'audio') {
        let output;
        try {
          output = await media.renderIndividualAudio(mediaRecord(state, record, mediaDir));
        } finally {
          checkRecordStillExists();
        }
        return sendExport(response, output, `Still-${record.capturedAt.slice(0, 10)}-${id.slice(0, 8)}.m4a`);
      }
      if (!action && method === 'PATCH' && record.kind === 'audio') {
        const body = await readJson(request);
        const transcript = typeof body.transcript === 'string' && body.transcript.trim();
        if (!transcript || transcript.length > 5000) throw new HttpError(400, '녹음 내용을 1~5,000자로 입력해 주세요.');
        const updated = await mutate((draft) => {
          const stored = draft.records[record.id];
          if (!stored) throw new HttpError(404, '기록을 찾을 수 없어요.');
          stored.transcript = transcript;
          stored.transcriptStatus = 'ready';
          return stored;
        });
        return json(response, { record: recordView(state, updated) });
      }
    }

    if (method === 'GET' && pathname === '/api/export') {
      const query = readExportQuery(searchParams);
      const snapshot = state;
      const records = Object.values(snapshot.records).filter((record) => {
        const day = query.dayInZone(record.capturedAt);
        return day >= query.from && day <= query.to;
      }).sort(recordCompare).map((record) => mediaRecord(snapshot, record, mediaDir));
      if (!records.length) throw new HttpError(422, '선택한 기간에 기록이 없어요.', 'EMPTY_EXPORT');
      let output;
      try {
        output = await media.renderArchive(records, { format: query.format, includeAudio: query.mode === 'mixed', timeZone: query.timeZone });
      } finally {
        if (records.some(({ id }) => !state.records[id])) {
          throw new HttpError(409, '내보내는 중에 기록이 삭제됐어요. 다시 시도해 주세요.', 'EXPORT_RECORDS_CHANGED');
        }
      }
      return sendExport(response, output, `Still-${query.from}-${query.to}.${output.extension}`,
        query.inline && query.format === 'mp4', request.headers.range);
    }

    if (pathname === '/api/home') {
      if (method === 'GET') return json(response, { home: viewHome(state.home, user.id) });
      if (method === 'PUT') {
        if (state.home.ownerId !== user.id) throw new HttpError(403, '주소를 등록한 사람만 수정할 수 있습니다.');
        const body = await readJson(request);
        const address = typeof body.address === 'string' && body.address.trim();
        if (!address || address.length > 200) throw new HttpError(400, '상세 주소를 1~200자로 입력해 주세요.');
        await mutate((draft) => {
          if (draft.home.address !== address) delete draft.home.buildingMatch;
          draft.home.address = address;
        });
        return json(response, { home: viewHome(state.home, user.id) });
      }
    }

    throw new HttpError(404, '요청한 페이지를 찾을 수 없어요.');
  }

  for (const record of Object.values(state.records)) scheduleTranscription(record);
  const handleRequest = (request, response) => {
    void route(request, response).catch((error) => reportError(response, error));
  };
  return tls ? createSecureServer(tls, handleRequest) : createServer(handleRequest);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  const certPath = process.env.OURDAYS_TLS_CERT;
  const keyPath = process.env.OURDAYS_TLS_KEY;
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('Set both OURDAYS_TLS_CERT and OURDAYS_TLS_KEY to enable HTTPS.');
  const tls = certPath ? { cert: await readFile(certPath), key: await readFile(keyPath) } : undefined;
  const app = await createApp({ tls });
  const displayHost = host.includes(':') ? `[${host}]` : host;
  app.listen(port, host, () => console.log(`Still · ${tls ? 'https' : 'http'}://${displayHost}:${app.address().port}`));
}
