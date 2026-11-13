import test from 'node:test';
import assert from 'node:assert/strict';
import { anonymousSession, offlineSession, validateAuthFields, isNetworkFailure } from '../public/auth-state.js';

const session = {
  user: { id: 'member-a', name: '서연', role: 'owner', member: true, email: 'private@example.test', access_token: 'do-not-cache' },
  family: {
    id: 'family-one', name: '우리 가족', inviteCode: 'SECRET-INVITE', inviteExpiresAt: '2027-01-01',
    members: [{ id: 'member-a', name: '서연', role: 'owner', email: 'private@example.test' }]
  },
  backend: 'supabase', demo: false, access_token: 'do-not-cache', refresh_token: 'do-not-cache',
  auth: { signup: true, recovery: true, secret: 'do-not-cache' }
};

test('offline display cache excludes auth credentials and private invitation data at every level', () => {
  const before = structuredClone(session);
  const cached = offlineSession(session);
  assert.deepEqual(cached, {
    user: { id: 'member-a', name: '서연', role: 'owner', member: true },
    family: { id: 'family-one', name: '우리 가족', members: [{ id: 'member-a', name: '서연', role: 'owner' }] },
    backend: 'supabase', demo: false, auth: { signup: true, recovery: true }
  });
  assert.equal(JSON.stringify(cached).includes('do-not-cache'), false);
  assert.equal(JSON.stringify(cached).includes('SECRET-INVITE'), false);
  assert.deepEqual(session, before);
});

test('signed-out, removed-family and password-recovery sessions never restore private offline access', () => {
  const anonymous = anonymousSession(session);
  assert.equal(anonymous.user, null);
  assert.equal(anonymous.family, null);
  for (const denied of [null, anonymous, { ...session, family: null }, { ...session, recovery: true },
    { ...session, user: { ...session.user, member: false } },
    { ...session, family: { ...session.family, members: [] } }]) {
    assert.equal(offlineSession(denied), null);
  }
  assert.deepEqual(anonymous.auth, { signup: true, recovery: true });
});

test('HTTP authorization, server and response parsing failures do not qualify for offline cache fallback', () => {
  for (const status of [401, 403, 429, 500, 502, 503]) assert.equal(isNetworkFailure({ status }), false);
  assert.equal(isNetworkFailure(new SyntaxError('not json')), false);
  assert.equal(isNetworkFailure(Object.assign(new Error('fetch unavailable'), { network: true })), true);
});

test('signup and recovery check confirmation and length without changing the password entered', () => {
  const fields = { name: '서연', password: 'long password 1 ', passwordConfirm: 'long password 1 ' };
  assert.equal(validateAuthFields('signup', fields), '');
  assert.equal(validateAuthFields('password-update', fields), '');
  assert.match(validateAuthFields('signup', { ...fields, name: ' ' }), /이름/);
  assert.match(validateAuthFields('signup', { ...fields, password: 'short', passwordConfirm: 'short' }), /10/);
  assert.match(validateAuthFields('password-update', { ...fields, passwordConfirm: 'long password 1' }), /서로/);
  assert.equal(validateAuthFields('login', { password: 'demo2026!' }), '');
});
