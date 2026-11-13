import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPolicyDatabase } from '../supabase/tests/pglite.mjs';

test('real PostgreSQL: family RLS, invitations, immutable uploads, deletion and private addresses', async t => {
  const { db, asUser, rpc } = await createPolicyDatabase();
  t.after(() => db.close());
  // An unrelated application's permissive policies must not weaken Still's bucket.
  await db.exec(`
    create policy another_app_read on storage.objects for select to public using(true);
    create policy another_app_insert on storage.objects for insert to public with check(true);
    create policy another_app_update on storage.objects for update to public using(true) with check(true);
    create policy another_app_delete on storage.objects for delete to public using(true);
    grant select,insert,update,delete on storage.objects to anon;
  `);
  const [a, b, c, d, unverified] = Array.from({ length: 5 }, () => randomUUID());
  for (const [index, id] of [a,b,c,d,unverified].entries()) {
    await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,$3,$4)',
      [id, `member-${index}@example.test`, id === unverified ? null : new Date(), { name: '멤버 ' + index }]);
  }
  await assert.rejects(asUser('', () => rpc('session'), 'anon'), /permission denied/);
  await assert.rejects(asUser(unverified, () => rpc('session')), /STILL_AUTH_REQUIRED/);
  const first = await asUser(a, () => rpc('create_family', ['첫 번째 공간']));
  const second = await asUser(c, () => rpc('create_family', ['두 번째 공간']));
  const familyA = first.family.id;
  const familyC = second.family.id;
  assert.notEqual(familyA, familyC);
  assert.equal(first.family.members.length, 1);
  const oldInvite = first.family.inviteCode;
  assert.equal(oldInvite.length, 32);
  const joined = await asUser(b, () => rpc('join_family', [oldInvite]));
  assert.equal(joined.family.id, familyA);
  assert.equal(joined.family.members.length, 2);
  assert.equal(joined.family.inviteCode, undefined);
  await assert.rejects(asUser(b, () => rpc('rotate_invite')), /STILL_OWNER_REQUIRED/);
  const rotated = await asUser(a, () => rpc('rotate_invite'));
  assert.notEqual(rotated.family.inviteCode, oldInvite);
  assert.equal((await asUser(d, () => rpc('join_family', [oldInvite]))).error, 'STILL_INVITE_INVALID');
  await db.query("update public.still_invitations set expires_at=now()-interval '1 second' where family_id=$1", [familyA]);
  assert.equal((await asUser(d, () => rpc('join_family', [rotated.family.inviteCode]))).error, 'STILL_INVITE_INVALID');
  for (let i=0;i<8;i++) await asUser(d, () => rpc('join_family', ['INVALID']));
  assert.equal((await asUser(d, () => rpc('join_family', ['INVALID']))).error, 'STILL_INVITE_RATE_LIMIT');

  await asUser(b, async () => {
    assert.equal((await db.query('select * from public.still_invitations')).rows.length, 0);
    assert.equal((await db.query('select * from public.still_families')).rows.length, 1);
    assert.equal((await db.query('select * from public.still_profiles')).rows.length, 2);
    await assert.rejects(db.query("insert into public.still_families(name,owner_id) values('forged',$1)", [b]), /permission denied/);
    await assert.rejects(db.query('select still_private.record_json(null::public.still_records)'), /permission denied/);
  });

  const id = randomUUID();
  const reserveArgs = [id, 'audio', '2026-11-09T10:00:00Z', 3000, 'audio/mp4', 20];
  const pending = await asUser(a, () => rpc('reserve_record', reserveArgs));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.familyId, familyA);
  assert.equal((await asUser(a, () => rpc('list_records'))).length, 0);
  assert.equal(await asUser(b, () => rpc('get_record', [id])), null);
  await assert.rejects(asUser(c, () => rpc('reserve_record', reserveArgs)), /STILL_RECORD_CONFLICT/);
  await assert.rejects(asUser(a, () => rpc('finish_record', [id])), /STILL_UPLOAD_INCOMPLETE/);
  const insertObject = record => db.query('insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',
    ['still-recordings', record.storagePath, record.authorId, { size: 20, mimetype: 'audio/mp4' }]);
  await assert.rejects(asUser(c, () => insertObject(pending)), /row-level security/);
  await asUser(a, () => insertObject(pending));
  const ready = await asUser(a, () => rpc('finish_record', [id]));
  assert.equal(ready.status, 'ready');
  assert.equal(ready.updatedAt, ready.uploadedAt);
  assert.equal(Date.parse(ready.capturedAt), Date.parse(reserveArgs[2]));
  assert.ok(Date.parse(ready.uploadedAt) > Date.parse(ready.capturedAt));
  assert.deepEqual(await asUser(a, () => rpc('reserve_record', reserveArgs)), ready);
  assert.equal((await asUser(a, () => rpc('finish_record', [id]))).uploadedAt, ready.uploadedAt);
  await assert.rejects(asUser(a, () => rpc('reserve_record', [...reserveArgs.slice(0, 5), 21])), /STILL_RECORD_CONFLICT/);
  await asUser(b, async () => {
    assert.equal((await rpc('list_records')).length, 1);
    assert.equal((await db.query('select * from storage.objects')).rows.length, 1);
    const updated = await db.query("update storage.objects set metadata='{}'::jsonb where name=$1 returning id", [pending.storagePath]);
    assert.equal(updated.rows.length, 0, 'ready objects stay immutable despite another app update policy');
  });
  assert.equal((await asUser('', () => db.query('select * from storage.objects'), 'anon')).rows.length, 0);
  await asUser(c, async () => {
    assert.deepEqual(await rpc('list_records'), []);
    assert.equal(await rpc('get_record', [id]), null);
    assert.equal((await db.query('select * from public.still_records')).rows.length, 0);
    assert.equal((await db.query('select * from storage.objects')).rows.length, 0);
    await assert.rejects(rpc('set_transcript', [id, 'foreign update', false]), /STILL_RECORD_MISSING/);
  });
  const automatic = await asUser(b, () => rpc('set_transcript', [id, '자동 전사', true]));
  assert.equal(automatic.updatedAt, ready.updatedAt);
  const edited = await asUser(b, () => rpc('set_transcript', [id, '고친 문장', false]));
  assert.ok(Date.parse(edited.updatedAt) >= Date.parse(automatic.updatedAt));
  assert.equal((await asUser(a, () => rpc('set_transcript', [id, '늦은 자동 전사', true]))).transcript, '고친 문장');

  await asUser(a, () => rpc('update_home', ['서울시 상세주소 비공개']));
  assert.equal((await asUser(a, () => rpc('get_home'))).address, '서울시 상세주소 비공개');
  const publicHome = await asUser(b, () => rpc('get_home'));
  assert.equal(publicHome.address, undefined);
  assert.equal(publicHome.hasAddress, true);
  assert.equal((await asUser(b, () => db.query('select * from public.still_homes'))).rows.length, 0);
  await assert.rejects(asUser(b, () => rpc('update_home', ['forged'])), /STILL_OWNER_REQUIRED/);
  await assert.rejects(asUser(b, () => rpc('delete_record', [id])), /STILL_DELETE_FORBIDDEN/);
  const deleted = await asUser(a, () => rpc('delete_record', [id]));
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.transcript, null);
  assert.equal((await asUser(a, () => rpc('delete_record', [id]))).storagePath, pending.storagePath);
  assert.equal(await asUser(a, () => rpc('get_record', [id])), null);
  assert.equal((await asUser(b, () => db.query('select * from storage.objects'))).rows.length, 0);
  assert.equal((await asUser(a, () => db.query('select * from storage.objects'))).rows.length, 1);
  await assert.rejects(asUser(a, () => rpc('finish_record', [id])), /STILL_RECORD_DELETED/);
  await assert.rejects(asUser(a, () => rpc('reserve_record', reserveArgs)), /STILL_RECORD_DELETED/);
  // Storage DELETE needs SELECT visibility as well. This verifies cleanup after tombstoning.
  await asUser(a, () => db.query('delete from storage.objects where name=$1', [pending.storagePath]));
  assert.equal((await db.query('select * from storage.objects where name=$1', [pending.storagePath])).rows.length, 0);

  const deletedBeforeUpload = randomUUID();
  assert.equal(await asUser(a, () => rpc('delete_record', [deletedBeforeUpload])), null);
  await assert.rejects(asUser(a, () => rpc('reserve_record', [deletedBeforeUpload,...reserveArgs.slice(1)])), /STILL_RECORD_DELETED/);
  const other = await asUser(a, () => rpc('reserve_record', [randomUUID(),...reserveArgs.slice(1)]));
  await asUser(a, () => rpc('delete_record', [other.id]));
  await assert.rejects(asUser(a, () => insertObject(other)), /row-level security/);
  await assert.rejects(asUser(a, () => rpc('reserve_record', [randomUUID(), 'audio', reserveArgs[2], 10000, 'audio/mp4',16777217])), /STILL_BAD_RECORD/);
  // Unverified sizes cannot buy unlimited uploads: each pending object reserves
  // the bucket maximum until immutable bytes are verified at finalization.
  const unfinished = [];
  for (let i=0;i<16;i++) unfinished.push(await asUser(a, () => rpc('reserve_record', [randomUUID(), ...reserveArgs.slice(1)])));
  await assert.rejects(asUser(a, () => rpc('reserve_record', [randomUUID(), ...reserveArgs.slice(1)])), /STILL_STORAGE_QUOTA/);
  await asUser(a, () => insertObject(unfinished[0]));
  await asUser(a, () => rpc('delete_record', [unfinished[0].id]));
  await assert.rejects(asUser(a, () => rpc('reserve_record', [randomUUID(), ...reserveArgs.slice(1)])), /STILL_STORAGE_QUOTA/);
  await asUser(a, () => db.query('delete from storage.objects where name=$1', [unfinished[0].storagePath]));
  assert.equal((await asUser(a, () => rpc('reserve_record', [randomUUID(), ...reserveArgs.slice(1)]))).status, 'pending');
  const otherFamilyRecord = await asUser(c, () => rpc('reserve_record', [randomUUID(), ...reserveArgs.slice(1)]));
  await asUser(c, () => insertObject(otherFamilyRecord));
  await asUser(c, () => rpc('finish_record', [otherFamilyRecord.id]));
  const failed = await asUser(c, () => rpc('set_transcript', [otherFamilyRecord.id, null, true]));
  assert.equal(failed.transcriptStatus, 'failed');
  assert.equal(failed.transcript, null);
  assert.equal((await asUser(a, () => rpc('list_records'))).length, 0);
  await assert.rejects(asUser('', () => db.query('select * from public.still_records'), 'anon'), /permission denied/);
});
