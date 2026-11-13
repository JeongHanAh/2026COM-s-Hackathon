import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const COOKIE = 'still_session';
const MAX_AGE = 30 * 86400;
const RECOVERY_AGE = 15 * 60 * 1000;
const failure = (status, message, code) => Object.assign(new Error(message), { status, code });

export function validateEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw failure(400, '이메일 주소를 확인해 주세요.', 'INVALID_EMAIL');
  }
  return value.trim().toLowerCase();
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw failure(400, '비밀번호는 10~128자로 입력해 주세요.', 'INVALID_PASSWORD');
  }
  return value;
}

export function createCloudAuth({ url, key, secret, origin, secureCookie = false, fetchImpl = fetch, now = Date.now }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('STILL_SESSION_SECRET must contain at least 32 characters.');
  const encryptionKey = createHash('sha256').update(secret).digest();
  const base = url.replace(/\/$/, '') + '/auth/v1';
  const refreshed = new Map();

  async function call(path, { method = 'POST', body, token } = {}) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method,
        headers: { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw failure(503, '로그인 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.', 'AUTH_UNAVAILABLE');
    }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const reason = data?.error_code || data?.code;
      if (response.status === 429) throw failure(429, '요청이 많습니다. 잠시 뒤 다시 시도해 주세요.', 'AUTH_RATE_LIMIT');
      if (response.status >= 500) throw failure(503, '로그인 서버가 응답하지 않아요. 잠시 뒤 다시 시도해 주세요.', 'AUTH_UNAVAILABLE');
      if (reason === 'weak_password') throw failure(400, '더 안전한 비밀번호를 입력해 주세요.', 'INVALID_PASSWORD');
      if (reason === 'email_address_invalid') throw failure(400, '이메일 주소를 확인해 주세요.', 'INVALID_EMAIL');
      if (['signup_disabled', 'email_provider_disabled', 'captcha_failed'].includes(reason)) {
        throw failure(503, '가입 설정을 확인해야 합니다. 관리자에게 알려 주세요.', 'AUTH_CONFIGURATION');
      }
      if (['email_not_confirmed', 'email_address_not_authorized'].includes(reason)) {
        throw failure(401, '받은 메일에서 이메일 확인을 마친 뒤 로그인해 주세요.', 'EMAIL_NOT_CONFIRMED');
      }
      throw failure(401, '이메일 또는 비밀번호를 확인해 주세요.', 'SIGN_IN_REQUIRED');
    }
    return data;
  }

  function encode(session) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(COOKIE));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    const value = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    if (value.length > 3800) throw failure(503, '로그인 정보를 저장하지 못했어요.', 'SESSION_TOO_LARGE');
    return value;
  }

  function decode(request) {
    const encoded = /(?:^|;\s*)still_session=([A-Za-z0-9_-]+)(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    if (!encoded || encoded.length > 3800) return null;
    try {
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length < 29) return null;
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(COOKIE));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const session = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      if (typeof session.accessToken !== 'string' || typeof session.refreshToken !== 'string'
        || !Number.isFinite(session.expiresAt) || !Number.isFinite(session.createdAt)
        || session.createdAt > now() + 60000 || session.createdAt + MAX_AGE * 1000 <= now()) return null;
      return { ...session, recovery: Number.isFinite(session.recoveryUntil) && session.recoveryUntil > now() };
    } catch { return null; }
  }

  function save(response, session) {
    const value = session ? encode(session) : '';
    const seconds = session ? Math.max(0, Math.floor((session.createdAt + MAX_AGE * 1000 - now()) / 1000)) : 0;
    response.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secureCookie ? '; Secure' : ''}`);
  }

  function sessionFrom(data, previous = {}) {
    if (!data?.access_token || !data?.refresh_token) throw failure(502, '로그인 응답을 확인하지 못했어요.', 'AUTH_INVALID_RESPONSE');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now() + Math.max(1, Math.min(Number(data.expires_in) || 3600, 86400)) * 1000,
      createdAt: previous.createdAt || now(),
      recoveryUntil: previous.recoveryUntil || 0,
      recovery: Number.isFinite(previous.recoveryUntil) && previous.recoveryUntil > now(),
    };
  }

  async function refresh(session) {
    const identity = createHash('sha256').update(session.refreshToken).digest('hex');
    for (const [id, entry] of refreshed) if (entry.until <= now()) refreshed.delete(id);
    let entry = refreshed.get(identity);
    if (!entry) {
      if (refreshed.size >= 1000) refreshed.delete(refreshed.keys().next().value);
      entry = { until: now() + 10000, task: call('/token?grant_type=refresh_token', { body: { refresh_token: session.refreshToken } }) };
      refreshed.set(identity, entry);
      entry.task.catch(() => { if (refreshed.get(identity) === entry) refreshed.delete(identity); });
    }
    return sessionFrom(await entry.task, session);
  }

  async function current(request, response) {
    let session = decode(request);
    if (!session) return null;
    let changed = false;
    try {
      if (session.expiresAt <= now() + 60000) { session = await refresh(session); changed = true; }
      let user;
      try { user = await call('/user', { method: 'GET', token: session.accessToken }); }
      catch (error) {
        if (error.status !== 401 || changed) throw error;
        session = await refresh(session);
        changed = true;
        user = await call('/user', { method: 'GET', token: session.accessToken });
      }
      if (!user?.id) throw failure(401, '다시 로그인해 주세요.', 'SIGN_IN_REQUIRED');
      if (changed) save(response, session);
      return { ...session, user };
    } catch (error) {
      if (error.status !== 401) throw error;
      save(response, null);
      return null;
    }
  }

  async function login(response, email, password) {
    email = validateEmail(email);
    if (typeof password !== 'string' || !password || password.length > 128) throw failure(400, '비밀번호를 입력해 주세요.', 'INVALID_PASSWORD');
    const data = await call('/token?grant_type=password', { body: { email, password } });
    const session = sessionFrom(data);
    const user = await call('/user', { method: 'GET', token: session.accessToken });
    if (!user?.id) throw failure(502, '로그인 정보를 확인하지 못했어요.', 'AUTH_INVALID_RESPONSE');
    save(response, session);
    return { ...session, user };
  }

  async function signup(response, { name, email, password }) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 48) throw failure(400, '이름은 1~48자로 입력해 주세요.', 'INVALID_NAME');
    email = validateEmail(email);
    password = validatePassword(password);
    let data;
    try {
      data = await call(`/signup${origin ? '?redirect_to=' + encodeURIComponent(origin + '/auth/confirm') : ''}`, {
        body: { email, password, data: { name: name.trim() } },
      });
    } catch (error) {
      // Do not disclose whether an email is already registered.
      if (error.status !== 401) throw error;
      return null;
    }
    if (!data?.access_token) return null;
    const session = sessionFrom(data);
    const user = await call('/user', { method: 'GET', token: session.accessToken });
    if (!user?.id) throw failure(502, '로그인 정보를 확인하지 못했어요.', 'AUTH_INVALID_RESPONSE');
    save(response, session);
    return { ...session, user };
  }

  async function confirm(response, tokenHash, type) {
    if (!['signup', 'recovery'].includes(type) || typeof tokenHash !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(tokenHash)) {
      throw failure(400, '확인 링크가 올바르지 않아요.', 'INVALID_CONFIRMATION');
    }
    const data = await call('/verify', { body: { token_hash: tokenHash, type } });
    const session = sessionFrom(data, { recoveryUntil: type === 'recovery' ? now() + RECOVERY_AGE : 0 });
    const user = await call('/user', { method: 'GET', token: session.accessToken });
    if (!user?.id) throw failure(401, '확인 링크가 만료됐어요.', 'INVALID_CONFIRMATION');
    save(response, session);
    return { ...session, user };
  }

  async function reset(email) {
    email = validateEmail(email);
    try {
      await call(`/recover${origin ? '?redirect_to=' + encodeURIComponent(origin + '/auth/confirm') : ''}`, { body: { email } });
    } catch (error) {
      if (error.status !== 401) throw error;
    }
  }

  async function updatePassword(response, session, password) {
    if (!Number.isFinite(session.recoveryUntil) || session.recoveryUntil <= now()) {
      throw failure(403, '이메일의 비밀번호 재설정 링크로 다시 접속해 주세요.', 'RECOVERY_REQUIRED');
    }
    validatePassword(password);
    const user = await call('/user', { method: 'PUT', token: session.accessToken, body: { password } });
    const updated = { ...session, user, recovery: false, recoveryUntil: 0 };
    save(response, { accessToken: updated.accessToken, refreshToken: updated.refreshToken, expiresAt: updated.expiresAt, createdAt: updated.createdAt, recovery: false, recoveryUntil: 0 });
    return updated;
  }

  async function logout(response, session) {
    try {
      if (session) {
        if (session.expiresAt <= now() + 60000) session = await refresh(session);
        await call('/logout?scope=local', { token: session.accessToken });
      }
    } catch (error) {
      if (error.status !== 401) throw failure(error.status || 503,
        '이 기기에서는 로그아웃했지만 서버의 로그인 연결은 종료하지 못했어요.', 'LOGOUT_REVOKE_FAILED');
    } finally { save(response, null); }
  }

  // Logout must clear the local cookie even when /user or token refresh is unavailable.
  const logoutRequest = (request, response) => logout(response, decode(request));
  return { current, login, signup, confirm, reset, updatePassword, logout, logoutRequest };
}
