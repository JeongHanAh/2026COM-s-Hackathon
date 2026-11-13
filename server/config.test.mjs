import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadConfig, validatePublicBackend } from './config.mjs';

async function cleanup(path) {
  assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep + 'still-'));
  await rm(path, { recursive: true, force: true });
}

test('public shared config rejects admin credentials and non-HTTPS remote endpoints', () => {
  const url = 'https://still-example.supabase.co';
  const token = role => 'header.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.signature';
  assert.throws(() => validatePublicBackend({ url, key: 'sb_secret_sensitive' }));
  assert.throws(() => validatePublicBackend({ url, key: token('service_role') }));
  assert.throws(() => validatePublicBackend({ url: 'http://example.test', key: 'sb_publishable_example' }));
  assert.equal(validatePublicBackend({ url, key: token('anon') }).url, url);
});

test('production fails closed without HTTPS or durable session secret, and cannot expose local demo', async () => {
  const env = { NODE_ENV: 'production', SUPABASE_URL: 'https://still-example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' };
  await assert.rejects(loadConfig({ env }), /HTTPS/);
  await assert.rejects(loadConfig({ env: { ...env, OURDAYS_ORIGIN: 'https://still.example' } }), /STILL_SESSION_SECRET/);
  await assert.rejects(loadConfig({ env: { ...env, STILL_BACKEND: 'local' } }), /로컬 데모/);
  const config = await loadConfig({ env: { ...env, OURDAYS_ORIGIN: 'https://still.example', STILL_SESSION_SECRET: 'long-secret-'.repeat(5) } });
  assert.equal(config.secureCookie, true);
  assert.equal(config.host, '0.0.0.0');
});

test('two independent clones retain separate private session secrets while using one shared backend', async () => {
  const first = await mkdtemp(join(tmpdir(), 'still-config-a-'));
  const second = await mkdtemp(join(tmpdir(), 'still-config-b-'));
  const env = { SUPABASE_URL: 'https://still-example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' };
  try {
    const a = await loadConfig({ env, root: first });
    const b = await loadConfig({ env, root: second });
    assert.equal(a.supabaseUrl, b.supabaseUrl);
    assert.equal(a.supabaseKey, b.supabaseKey);
    assert.notEqual(a.sessionSecret, b.sessionSecret);
    assert.equal((await loadConfig({ env, root: first })).sessionSecret, a.sessionSecret);
    assert.equal(await readFile(join(first, '.local/session.key'), 'utf8'), a.sessionSecret);
  } finally { await cleanup(first); await cleanup(second); }
});

test('missing cloud configuration never silently creates an unrelated local family', async () => {
  const root = await mkdtemp(join(tmpdir(), 'still-empty-config-'));
  try {
    await assert.rejects(loadConfig({ env: {}, root }), /SUPABASE_URL/);
    assert.equal((await loadConfig({ env: {}, root, demo: true })).backend, 'local');
  } finally { await cleanup(root); }
});
