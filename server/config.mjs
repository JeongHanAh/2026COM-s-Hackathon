import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function validatePublicBackend({ url, key }) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new Error('SUPABASE_URL에 프로젝트 주소를 설정해 주세요.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Supabase 주소는 경로나 비밀번호가 없는 HTTPS 프로젝트 주소여야 합니다.');
  }
  if (typeof key !== 'string' || !key || key.startsWith('sb_secret_')) throw new Error('공개 가능한 Supabase publishable 키를 사용해 주세요. 비밀 키는 사용할 수 없습니다.');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    let payload;
    try { payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()); } catch {}
    if (key.split('.').length !== 3 || payload?.role !== 'anon') throw new Error('publishable 키 또는 legacy anon 키만 사용할 수 있습니다. service_role 키를 넣지 마세요.');
  }
  return { url: endpoint.origin, key };
}

export async function loadConfig({ env = process.env, root = projectRoot, demo = false } = {}) {
  let shared = {};
  try { shared = JSON.parse(await readFile(join(root, 'shared-backend.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('shared-backend.json을 읽을 수 없습니다.'); }
  const backend = demo ? 'local' : env.STILL_BACKEND || 'supabase';
  if (!['local', 'supabase'].includes(backend)) throw new Error('STILL_BACKEND는 supabase 또는 local이어야 합니다.');
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || (production ? '0.0.0.0' : '127.0.0.1');
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1~65535 사이여야 합니다.');
  if (backend === 'local') {
    if (production || !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('로컬 데모는 이 PC에서만 실행할 수 있습니다. 외부 배포에는 Supabase 모드를 사용하세요.');
    return { backend, host, port };
  }
  const { url, key } = validatePublicBackend({ url: env.SUPABASE_URL || shared.url, key: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || shared.publishableKey });
  const origin = env.OURDAYS_ORIGIN || `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
  let address;
  try { address = new URL(origin); } catch { throw new Error('OURDAYS_ORIGIN에 앱 주소를 설정해 주세요.'); }
  if (address.origin !== origin || address.username || address.password || !['http:', 'https:'].includes(address.protocol)) throw new Error('OURDAYS_ORIGIN은 경로 없는 앱 주소여야 합니다.');
  if ((production || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) && address.protocol !== 'https:') throw new Error('외부에서 사용하는 앱 주소는 HTTPS여야 합니다.');
  let sessionSecret = env.STILL_SESSION_SECRET;
  if (!sessionSecret && !production) {
    const local = join(root, '.local');
    await mkdir(local, { recursive: true, mode: 0o700 });
    const path = join(local, 'session.key');
    try { sessionSecret = await readFile(path, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      sessionSecret = randomBytes(48).toString('base64url');
      try { await writeFile(path, sessionSecret, { flag: 'wx', mode: 0o600 }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; sessionSecret = await readFile(path, 'utf8'); }
    }
  }
  if (typeof sessionSecret !== 'string' || sessionSecret.length < 32) throw new Error('STILL_SESSION_SECRET에 32자 이상의 무작위 값을 설정해 주세요.');
  return { backend, host, port, supabaseUrl: url, supabaseKey: key, sessionSecret, origin,
    secureCookie: address.protocol === 'https:' || env.OURDAYS_SECURE_COOKIE === '1',
    maxExportRecords: 100, maxExportBytes: 128 * 1024 * 1024 };
}
