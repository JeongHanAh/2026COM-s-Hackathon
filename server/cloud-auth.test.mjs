import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudAuth } from './cloud-auth.mjs';

const config = { url: 'https://test.supabase.co', key: 'sb_publishable_test', secret: 'test-only-session-key-with-at-least-32-chars', origin: 'https://still.example', secureCookie: true };
const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; } });
const request = result => ({ headers: { cookie: result.headers['set-cookie']?.split(';')[0] || '' } });

function fixture() {
  let clock = 1700000000000;
  let refreshes = 0;
  let unavailable = false;
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.apikey, config.key);
    calls.push({ url, init });
    if (unavailable) throw new Error('network down');
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (parsed.pathname.endsWith('/token')) {
      if (parsed.searchParams.get('grant_type') === 'refresh_token') {
        refreshes++;
        assert.equal(body.refresh_token, 'refresh-original');
        return Response.json({ access_token: 'access-refreshed', refresh_token: 'refresh-new', expires_in: 3600 });
      }
      if (body.email !== 'person@example.test' || body.password !== 'strong-enough-password') return Response.json({ error_code: 'invalid_credentials' }, { status: 400 });
      return Response.json({ access_token: 'access-original', refresh_token: 'refresh-original', expires_in: 120 });
    }
    if (parsed.pathname.endsWith('/user')) {
      assert.match(init.headers.Authorization, /^Bearer access-/);
      return Response.json({ id: 'verified-user', email: 'person@example.test', user_metadata: { name: '민수' } });
    }
    if (parsed.pathname.endsWith('/signup')) return Response.json({ user: { id: 'pending-user' } });
    if (parsed.pathname.endsWith('/recover') || parsed.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
    if (parsed.pathname.endsWith('/verify')) {
      assert.equal(body.token_hash, 'test-email-hash-123456789');
      return Response.json({ access_token: 'access-recovery', refresh_token: 'refresh-original', expires_in: 120 });
    }
    throw new Error('unexpected auth path ' + parsed.pathname);
  };
  return { auth: createCloudAuth({ ...config, fetchImpl, now: () => clock }), calls,
    advance: ms => { clock += ms; }, setUnavailable: value => { unavailable = value; }, refreshes: () => refreshes };
}

test('cloud sessions are encrypted HttpOnly cookies and reject tampering or another installation key', async () => {
  const f = fixture();
  const res = response();
  const loggedIn = await f.auth.login(res, 'person@example.test', 'strong-enough-password');
  assert.equal(loggedIn.user.id, 'verified-user');
  assert.match(res.headers['set-cookie'], /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  assert.doesNotMatch(res.headers['set-cookie'], /access-original|refresh-original|verified-user/);
  assert.equal((await f.auth.current(request(res), response())).user.id, 'verified-user');
  const cookie = request(res).headers.cookie;
  assert.equal(await f.auth.current({ headers: { cookie: cookie.slice(0, -7) + 'changed' } }, response()), null);
  const other = createCloudAuth({ ...config, secret: 'another-private-installation-secret-0123456789', fetchImpl: () => { throw new Error('should not reach network'); } });
  assert.equal(await other.current(request(res), response()), null);
});

test('concurrent requests share one refresh and network failure does not silently clear the account', async () => {
  const f = fixture();
  const loggedIn = response();
  await f.auth.login(loggedIn, 'person@example.test', 'strong-enough-password');
  f.advance(61000);
  const responses = [response(), response()];
  const sessions = await Promise.all(responses.map(res => f.auth.current(request(loggedIn), res)));
  assert.equal(f.refreshes(), 1);
  assert.ok(sessions.every(session => session.accessToken === 'access-refreshed'));
  f.setUnavailable(true);
  const failureResponse = response();
  await assert.rejects(f.auth.current(request(responses[0]), failureResponse), error => error.status === 503);
  assert.equal(failureResponse.headers['set-cookie'], undefined);
});

test('email confirmation and recovery are explicit, with password validation and no open redirect', async () => {
  const f = fixture();
  assert.equal(await f.auth.signup(response(), { name: '민수', email: 'person@example.test', password: 'strong-enough-password' }), null);
  const signupCall = f.calls.find(call => call.url.includes('/signup'));
  assert.equal(new URL(signupCall.url).searchParams.get('redirect_to'), 'https://still.example/auth/confirm');
  await f.auth.reset('person@example.test');
  const res = response();
  const recovery = await f.auth.confirm(res, 'test-email-hash-123456789', 'recovery');
  assert.equal(recovery.recovery, true);
  await assert.rejects(f.auth.confirm(response(), 'test-email-hash-123456789', 'email_change'), error => error.status === 400);
  await assert.rejects(f.auth.updatePassword(response(), recovery, 'short'), error => error.status === 400);
  const updated = await f.auth.updatePassword(response(), recovery, 'another-strong-password');
  assert.equal(updated.recovery, false);
  await f.auth.logout(res, updated);
  assert.match(res.headers['set-cookie'], /Max-Age=0/);
});

test('password recovery expires after fifteen minutes and refreshing does not extend it', async () => {
  const f = fixture();
  const initial = response();
  const recovery = await f.auth.confirm(initial, 'test-email-hash-123456789', 'recovery');
  f.advance(61000);
  const refreshed = response();
  const active = await f.auth.current(request(initial), refreshed);
  assert.equal(active.recovery, true);
  assert.equal(active.recoveryUntil, recovery.recoveryUntil);
  f.advance(15 * 60 * 1000 - 61000);
  const expired = await f.auth.current(request(refreshed), response());
  assert.equal(expired.user.id, 'verified-user', 'ordinary login remains valid');
  assert.equal(expired.recovery, false);
  const before = f.calls.length;
  await assert.rejects(f.auth.updatePassword(response(), expired, 'another-strong-password'), error => error.status === 403);
  assert.equal(f.calls.length, before, 'expired recovery cannot reach password update');
});

test('logout clears a local cookie during an Auth outage and reports remote revocation failure', async () => {
  const f = fixture();
  const loggedIn = response();
  await f.auth.login(loggedIn, 'person@example.test', 'strong-enough-password');
  f.setUnavailable(true);
  const loggedOut = response();
  await assert.rejects(f.auth.logoutRequest(request(loggedIn), loggedOut), error => error.status === 503 && error.code === 'LOGOUT_REVOKE_FAILED');
  assert.match(loggedOut.headers['set-cookie'], /Max-Age=0/);
  assert.equal(await f.auth.current(request(loggedOut), response()), null);
});
