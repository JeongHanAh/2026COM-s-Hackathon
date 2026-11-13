import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRecords } from '../public/record-sync.js';

const identity = { authorId: 'family-a', familyId: 'room-1', partition: 'family-a/room-1' };
const pending = (id, fields = {}) => ({
  id, ...identity, approved: true, kind: 'audio',
  capturedAt: '2026-11-09T13:10:00.000Z', durationMs: 10000,
  blob: new Blob(['voice'], { type: 'audio/webm' }), ...fields
});
const deleted = (id, fields = {}) => ({ id, ...identity, synced: false, ...fields });

function scenario(records = [], deletions = []) {
  const outbox = new Map(records.map(record => [record.id, structuredClone(record)]));
  const tombstones = new Map(deletions.map(record => [record.id, structuredClone(record)]));
  const calls = [];
  const visible = [];
  const store = {
    readOutbox: async () => structuredClone([...outbox.values()]),
    readDeletions: async () => structuredClone([...tombstones.values()]),
    removePending: async id => outbox.delete(id),
    queueDeletion: async record => {
      if (!tombstones.has(record.id)) tombstones.set(record.id, deleted(record.id));
      outbox.delete(record.id);
    },
    markDeletionSynced: async id => { tombstones.get(id).synced = true; }
  };
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === '/api/session') return { user: { id: identity.authorId }, family: { id: identity.familyId } };
    if (options.method === 'DELETE') return null;
    assert.equal(options.method, 'POST');
    const record = outbox.get(options.headers['X-Record-Id']);
    return { record: { id: record.id, capturedAt: record.capturedAt, authorId: record.authorId } };
  };
  return {
    outbox, tombstones, calls, visible, api,
    options: { ...identity, store, api, onUploaded: record => visible.push(record) }
  };
}

test('only explicitly approved records are shared, including legacy stored records', async () => {
  const s = scenario([
    pending('draft', { approved: false }),
    pending('legacy', { approved: undefined }),
    pending('approved'),
    pending('other-account', { authorId: 'family-b', partition: 'family-b/room-1' })
  ]);
  const result = await syncRecords(s.options);
  assert.deepEqual(result, { uploaded: 1, deleted: 0 });
  assert.deepEqual(s.visible.map(item => item.id), ['approved']);
  assert.deepEqual([...s.outbox.keys()], ['draft', 'legacy', 'other-account']);
  const upload = s.calls.find(item => item.method === 'POST');
  assert.equal(upload.headers['X-Captured-At'], '2026-11-09T13:10:00.000Z');
  assert.equal(upload.headers['X-Record-Owner'], identity.authorId);
});

test('own deletions are sent before uploads and acknowledged tombstones stay durable', async () => {
  const s = scenario([pending('next')], [
    deleted('removed'),
    deleted('already-removed', { synced: true }),
    deleted('other-account', { authorId: 'family-b', partition: 'family-b/room-1' })
  ]);
  const result = await syncRecords(s.options);
  assert.deepEqual(result, { uploaded: 1, deleted: 1 });
  assert.deepEqual(s.calls.filter(item => item.method).map(item => item.method), ['DELETE', 'POST']);
  assert.equal(s.tombstones.get('removed').synced, true);
  assert.equal(s.tombstones.get('other-account').synced, false);
  assert.equal(s.tombstones.size, 3);
});

test('a deletion committed while upload is in flight hides its successful response', async () => {
  const s = scenario([pending('racing')]);
  const api = async (path, options) => {
    const reply = await s.api(path, options);
    if (options?.method === 'POST') await s.options.store.queueDeletion(pending('racing'));
    return reply;
  };
  const result = await syncRecords({ ...s.options, api });
  assert.deepEqual(result, { uploaded: 0, deleted: 1 });
  assert.deepEqual(s.visible, []);
  assert.equal(s.outbox.size, 0);
  assert.equal(s.tombstones.get('racing').synced, true);
  assert.deepEqual(s.calls.filter(item => item.method).map(item => item.method), ['POST', 'DELETE']);
});

test('a second tab deleting an item after the outbox snapshot prevents its upload', async () => {
  const s = scenario([pending('stale')]);
  const readOutbox = s.options.store.readOutbox;
  let reads = 0;
  s.options.store.readOutbox = async () => {
    reads++;
    if (reads === 2) await s.options.store.queueDeletion(pending('stale'));
    return readOutbox();
  };
  const result = await syncRecords(s.options);
  assert.deepEqual(result, { uploaded: 0, deleted: 1 });
  assert.equal(s.calls.some(item => item.method === 'POST'), false);
  assert.equal(s.tombstones.get('stale').synced, true);
});

test('server 410 removes an obsolete outbox item and preserves a local tombstone', async () => {
  const s = scenario([pending('gone')]);
  const api = async (path, options) => {
    if (options?.method === 'POST') throw Object.assign(new Error('gone'), { status: 410 });
    return s.api(path, options);
  };
  await syncRecords({ ...s.options, api });
  assert.equal(s.outbox.size, 0);
  assert.equal(s.tombstones.get('gone').synced, true);
  assert.deepEqual(s.visible, []);
});

test('an account switch after upload does not render that result or send the next item', async () => {
  const s = scenario([pending('first'), pending('second')]);
  let current = true;
  const api = async (path, options) => {
    const response = await s.api(path, options);
    if (options?.method === 'POST') current = false;
    return response;
  };
  const result = await syncRecords({ ...s.options, api, isCurrent: () => current });
  assert.deepEqual(result, { uploaded: 0, deleted: 0 });
  assert.deepEqual(s.visible, []);
  assert.deepEqual([...s.outbox.keys()], ['second']);
  assert.equal(s.calls.filter(item => item.method === 'POST').length, 1);
});

test('a server session for another account cannot sync this account queue', async () => {
  const s = scenario([pending('private')], [deleted('private-deletion')]);
  const api = async path => {
    assert.equal(path, '/api/session');
    return { user: { id: 'family-b' }, family: { id: identity.familyId } };
  };
  assert.deepEqual(await syncRecords({ ...s.options, api }), { uploaded: 0, deleted: 0 });
  assert.equal(s.outbox.size, 1);
  assert.equal(s.tombstones.get('private-deletion').synced, false);
});

test('a failed deletion remains pending and prevents later uploads in the same pass', async () => {
  const s = scenario([pending('next')], [deleted('pending-delete')]);
  const api = async (path, options) => {
    if (options?.method === 'DELETE') throw Object.assign(new Error('unauthorized'), { status: 403 });
    return s.api(path, options);
  };
  await assert.rejects(syncRecords({ ...s.options, api }), { status: 403 });
  assert.equal(s.tombstones.get('pending-delete').synced, false);
  assert.equal(s.outbox.size, 1);
  assert.deepEqual(s.visible, []);
});

test('one rejected media file leaves other approved uploads usable and skips repeated rejection', async () => {
  const s = scenario([pending('invalid'), pending('valid')]);
  const skipIds = new Set();
  const rejections = [];
  let invalidRequests = 0;
  const api = async (path, options) => {
    if (options?.headers?.['X-Record-Id'] === 'invalid') {
      invalidRequests++;
      throw Object.assign(new Error('bad media'), { status: 422 });
    }
    return s.api(path, options);
  };
  const options = { ...s.options, api, skipIds, onRejected: record => rejections.push(record.id) };
  assert.deepEqual(await syncRecords(options), { uploaded: 1, deleted: 0 });
  assert.deepEqual(await syncRecords(options), { uploaded: 0, deleted: 0 });
  assert.deepEqual(rejections, ['invalid']);
  assert.equal(invalidRequests, 1);
  assert.deepEqual(s.visible.map(item => item.id), ['valid']);
  assert.deepEqual([...s.outbox.keys()], ['invalid']);
});
