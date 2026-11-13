import { createHash, timingSafeEqual } from 'node:crypto';

const bucket = 'still-recordings';
const maxFileBytes = 16 * 1024 * 1024;
const errors = {
  STILL_AUTH_REQUIRED: [401, '이메일을 확인한 계정으로 로그인해 주세요.', 'SIGN_IN_REQUIRED'],
  STILL_FAMILY_REQUIRED: [403, '기록 공간에 먼저 가입해 주세요.', 'FAMILY_REQUIRED'],
  STILL_ALREADY_MEMBER: [409, '이미 기록 공간에 참여하고 있습니다.'],
  STILL_BAD_FAMILY: [400, '공간 이름을 1~60자로 입력해 주세요.'],
  STILL_INVITE_INVALID: [400, '초대 코드가 올바르지 않거나 만료됐어요.'],
  STILL_INVITE_RATE_LIMIT: [429, '초대 코드 확인을 잠시 후 다시 시도해 주세요.'],
  STILL_FAMILY_FULL: [409, '이 공간에는 최대 32명까지 참여할 수 있습니다.'],
  STILL_OWNER_REQUIRED: [403, '이 작업을 할 권한이 없습니다.'],
  STILL_RECORD_DELETED: [410, '이미 삭제된 기록이에요.', 'RECORD_DELETED'],
  STILL_RECORD_CONFLICT: [409, '이미 다른 내용으로 사용된 기록 번호예요.', 'RECORD_CONFLICT'],
  STILL_BAD_RECORD: [400, '기록 정보가 올바르지 않아요.', 'BAD_RECORD'],
  STILL_STORAGE_QUOTA: [413, '기록 보관 한도에 도달했습니다. 이전 기록을 내려받고 정리해 주세요.', 'STORAGE_QUOTA'],
  STILL_RECORD_MISSING: [404, '기록을 찾을 수 없어요.'],
  STILL_UPLOAD_INCOMPLETE: [409, '파일 업로드가 아직 끝나지 않았어요. 다시 시도해 주세요.', 'UPLOAD_INCOMPLETE'],
  STILL_DELETE_FORBIDDEN: [403, '기록을 남긴 사람만 삭제할 수 있습니다.', 'RECORD_DELETE_FORBIDDEN'],
  STILL_BAD_TRANSCRIPT: [400, '녹음 내용을 1~5,000자로 입력해 주세요.'],
  STILL_BAD_ADDRESS: [400, '주소를 300자 이내로 입력해 주세요.'],
  STILL_BAD_LOCATION: [400, '선택한 지역 정보가 올바르지 않아요.', 'BAD_LOCATION'],
  STILL_HOME_CHANGED: [409, '주소가 바뀌었어요. 새 주소의 지역을 다시 선택해 주세요.', 'HOME_CHANGED'],
};

function failure(code, status) {
  const known = errors[code];
  if (known) return Object.assign(new Error(known[1]), { status: known[0], code: known[2] || code });
  const messages = { 401: '다시 로그인해 주세요.', 403: '이 기록에 접근할 권한이 없습니다.',
    404: '기록 파일을 찾을 수 없어요.', 409: '이미 사용된 파일 이름이에요.', 413: '파일 크기 제한을 넘었어요.', 429: '잠시 후 다시 시도해 주세요.' };
  return Object.assign(new Error(messages[status] || '공용 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'),
    { status: messages[status] ? status : 503, code: 'SHARED_STORAGE_ERROR' });
}

function validateConfig(url, key) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('SUPABASE_URL을 올바른 주소로 설정해 주세요.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((!local && parsed.protocol !== 'https:') || !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('SUPABASE_URL에는 HTTPS 프로젝트 주소를 사용해 주세요.');
  }
  if (typeof key !== 'string' || key.length < 10 || /\s/.test(key) || key.startsWith('sb_secret_')) {
    throw new Error('공개 가능한 Supabase publishable/anon 키를 설정해 주세요.');
  }
  if (key.split('.').length === 3) {
    try {
      if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role !== 'anon') throw new Error();
    } catch { throw new Error('서버 관리 키 대신 Supabase publishable/anon 키를 사용해 주세요.'); }
  }
  return parsed.origin;
}

async function readLimited(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (length > limit) { await response.body?.cancel(); throw failure('TOO_LARGE', 413); }
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw failure('TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createSupabaseRepository({ url, key, fetchImpl = fetch }) {
  const origin = validateConfig(url, key);
  return {
    forUser(accessToken) {
      if (typeof accessToken !== 'string' || !accessToken || /\s/.test(accessToken)) throw failure('STILL_AUTH_REQUIRED');
      async function request(path, { method = 'POST', json, body, headers = {}, binary = false } = {}) {
        let response;
        try {
          response = await fetchImpl(origin + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(binary || body ? 45000 : 15000),
            headers: { apikey: key, Authorization: `Bearer ${accessToken}`, ...headers,
              ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: json !== undefined ? JSON.stringify(json) : body,
          });
        } catch { throw failure('CONNECTION_FAILED', 503); }
        if (!response.ok) {
          let payload;
          try { payload = JSON.parse((await readLimited(response, 16384)).toString()); } catch { payload = {}; }
          const name = payload.message || payload.error;
          const status = Number(payload.statusCode) || response.status;
          if (name === 'Duplicate' || name === 'The resource already exists' || payload.code === 'Duplicate') throw failure('DUPLICATE', 409);
          throw failure(name, status);
        }
        if (binary) return readLimited(response, maxFileBytes);
        if (response.status === 204) return null;
        let data;
        try { data = JSON.parse((await readLimited(response, 16 * 1024 * 1024)).toString()); }
        catch (error) { if (error.status) throw error; throw failure('BAD_RESPONSE', 503); }
        if (data?.error) throw failure(data.error, 400);
        return data;
      }
      const rpc = (name, args = {}) => request(`/rest/v1/rpc/still_${name}`, { json: args });
      const pathFor = record => {
        if (!record || typeof record.storagePath !== 'string' || !/^[a-f\d-]{36}\/[a-f\d-]{36}\/[a-f\d-]{36}\.media$/i.test(record.storagePath)) {
          throw failure('STILL_RECORD_MISSING');
        }
        return record.storagePath.split('/').map(encodeURIComponent).join('/');
      };
      return {
        session: () => rpc('session'),
        createFamily: name => rpc('create_family', { p_name: name }),
        joinFamily: code => rpc('join_family', { p_code: code }),
        rotateInvite: () => rpc('rotate_invite'),
        listRecords: () => rpc('list_records'),
        getRecord: id => rpc('get_record', { p_id: id }),
        reserveRecord: record => rpc('reserve_record', { p_id: record.id, p_kind: record.kind,
          p_captured_at: record.capturedAt, p_duration_ms: record.durationMs, p_mime_type: record.mimeType, p_size_bytes: record.sizeBytes }),
        finishRecord: id => rpc('finish_record', { p_id: id }),
        deleteRecord: id => rpc('delete_record', { p_id: id }),
        setTranscript: (id, text, { automatic = false } = {}) => rpc('set_transcript', { p_id: id, p_text: text, p_automatic: automatic }),
        getHome: () => rpc('get_home'),
        updateHome: address => rpc('update_home', { p_address: address }),
        updateHomeLocation: (location, expectedAddress) => rpc('update_home_location', { p_location: location, p_expected_address: expectedAddress }),
        async putObject(record, bytes) {
          if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maxFileBytes || bytes.length !== record.sizeBytes) throw failure('STILL_BAD_RECORD');
          try {
            await request(`/storage/v1/object/${bucket}/${pathFor(record)}`, { body: bytes,
              headers: { 'Content-Type': record.mimeType, 'x-upsert': 'false', 'Cache-Control': 'no-store' } });
          } catch (error) {
            if (error.status !== 409) throw error;
            // A lost response must be retryable, but an existing key never changes bytes.
            const previous = await this.readObject(record);
            const digest = input => createHash('sha256').update(input).digest();
            if (!timingSafeEqual(digest(previous), digest(bytes))) throw failure('STILL_RECORD_CONFLICT');
          }
        },
        readObject: record => request(`/storage/v1/object/authenticated/${bucket}/${pathFor(record)}`, { method: 'GET', binary: true }),
        async removeObject(record) {
          pathFor(record);
          await request(`/storage/v1/object/${bucket}`, { method: 'DELETE', json: { prefixes: [record.storagePath] } });
        },
      };
    },
  };
}
