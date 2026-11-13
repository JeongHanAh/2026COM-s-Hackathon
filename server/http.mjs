import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname,extname,resolve,sep,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { recordingLimits } from './media.mjs';
const publicDir=join(dirname(fileURLToPath(import.meta.url)),'../public');
const recordIdPattern=/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
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

function checkOrigin(request, expectedOrigin) {
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, '이 요청을 허용할 수 없어요.');
  }
  const origin = request.headers.origin;
  if (!origin) return;
  const expected = expectedOrigin || process.env.OURDAYS_ORIGIN || `${request.socket.encrypted || process.env.OURDAYS_SECURE_COOKIE === '1' ? 'https' : 'http'}://${request.headers.host}`;
  if (origin !== expected) throw new HttpError(403, '이 요청을 허용할 수 없어요.');
}


function readRecordHeaders(request) {
  const id = request.headers['x-record-id']?.toLowerCase();
  const kind = request.headers['x-record-kind'];
  const capturedAt = request.headers['x-captured-at'];
  const durationMs = Number(request.headers['x-duration-ms']);
  const limits = recordingLimits[kind];
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
  if (error instanceof HttpError || (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599)) {
    const message = /[가-힣]/.test(error.message || '') ? error.message : '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
    return json(response, { error: message, code: error.code }, error.status);
  }
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


export async function handleStatic(request,response){
  const { pathname }=new URL(request.url,'http://localhost');
  if(pathname.startsWith('/api/')||pathname.startsWith('/auth/')) return false;
  if(!['GET','HEAD'].includes(request.method)) throw new HttpError(405,'지원하지 않는 요청이에요.');
  let decoded;try{decoded=decodeURIComponent(pathname);}catch{throw new HttpError(400,'잘못된 주소입니다.');}
  if(pathname==='/')decoded='/index.html';
  const target=resolve(publicDir,'.'+decoded);
  if(!target.startsWith(resolve(publicDir)+sep))throw new HttpError(404,'페이지를 찾을 수 없어요.');
  const type=mimeTypes[extname(target).toLowerCase()];
  if(!type)throw new HttpError(404,'파일을 찾을 수 없어요.');
  await sendFile(request,response,target,type,{range:/^(video|audio)\//.test(type)});
  return true;
}
export {HttpError,json,noContent,readJson,readBody,checkOrigin,sendFile,sendExport,reportError,readRecordHeaders,validSignature,readExportQuery,checkRecordOwner};

export function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options','nosniff');
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('X-Frame-Options','DENY');
  response.setHeader('Permissions-Policy','camera=(self), microphone=(self), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src https://www.openstreetmap.org; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
