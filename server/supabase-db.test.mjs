import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

test('real PostgreSQL: coarse home locations are shared only inside the family and owner-controlled', async t => {
  const { db, asUser, rpc } = await createPolicyDatabase();
  t.after(() => db.close());
  const [owner, member, outsider, unaffiliated] = Array.from({ length: 4 }, () => randomUUID());
  for (const id of [owner, member, outsider, unaffiliated]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',
      [id, `${id}@example.test`]);
  }
  const family = await asUser(owner, () => rpc('create_family', ['위치를 공유하는 공간']));
  await asUser(member, () => rpc('join_family', [family.family.inviteCode]));
  await asUser(outsider, () => rpc('create_family', ['다른 공간']));
  const initial = await asUser(owner, () => rpc('get_home'));
  assert.equal(initial.location, null, 'a new family never inherits the demonstration area');
  assert.equal(initial.neighborhood, '');
  assert.equal(initial.status, '거주지 등록 대기');

  const privateAddress = '등록자만 보는 상세 주소 101호';
  await asUser(owner, () => rpc('update_home', [privateAddress]));
  // Reproduce the pre-upgrade table shape with existing family/address data.
  // The migration must add a nullable field without overwriting that data.
  await db.exec('alter table public.still_homes drop column location');
  await db.exec(await readFile(new URL('../supabase/migrations/20261114000300_still_home_location.sql', import.meta.url), 'utf8'));
  const upgraded = await asUser(owner, () => rpc('get_home'));
  assert.equal(upgraded.address, privateAddress);
  assert.equal(upgraded.location, null);
  assert.equal(upgraded.status, '우리 집 상태 미확인');
  const candidate = { id: 'osm:relation:1234', label: '서울 종로구', region: '서울특별시 종로구',
    lat: 37.57295, lon: 126.97945, newsQuery: '서울 종로구' };
  const saved = { ...candidate, lat: 37.57, lon: 126.98 };
  const home = await asUser(owner, () => rpc('update_home_location', [candidate, privateAddress]));
  assert.deepEqual(home.location, saved, 'precise input coordinates are rounded before sharing or persistence');
  assert.equal(home.neighborhood, candidate.region);
  assert.equal(home.address, privateAddress);
  assert.equal(home.status, '우리 집 상태 미확인');
  assert.equal(home.buildingObservation, null);
  assert.equal(home.dataset, undefined);
  const persisted = await db.query('select location,address from public.still_homes where family_id=$1', [family.family.id]);
  assert.deepEqual(persisted.rows[0], { location: saved, address: privateAddress });

  const shared = await asUser(member, () => rpc('get_home'));
  assert.deepEqual(shared.location, saved);
  assert.equal(shared.address, undefined);
  assert.equal(shared.canEdit, false);
  assert.equal(shared.hasAddress, true);
  assert.equal((await asUser(member, () => db.query('select * from public.still_homes'))).rows.length, 0);
  await assert.rejects(asUser(member, () => rpc('update_home_location', [candidate, privateAddress])), /STILL_OWNER_REQUIRED/);
  await assert.rejects(asUser(member, () => db.query("update public.still_homes set location='{}'::jsonb")), /permission denied/);
  assert.equal((await asUser(outsider, () => rpc('get_home'))).location, null);
  assert.equal((await asUser(outsider, () => db.query('select * from public.still_homes where family_id=$1', [family.family.id]))).rows.length, 0);
  await assert.rejects(asUser(unaffiliated, () => rpc('update_home_location', [candidate, privateAddress])), /STILL_FAMILY_REQUIRED/);
  await assert.rejects(asUser('', () => rpc('update_home_location', [candidate, privateAddress]), 'anon'), /permission denied/);

  const malformed = [null, [], 'Seoul', {}, { ...candidate, label: null }, { ...candidate, id: '' },
    { ...candidate, label: ' ' }, { ...candidate, region: 'x'.repeat(161) }, { ...candidate, label: 'x'.repeat(201) },
    { ...candidate, newsQuery: 'first\nsecond' }, { ...candidate, newsQuery: 'x'.repeat(201) },
    { ...candidate, lat: '37.57' }, { ...candidate, lon: null }, { ...candidate, lat: 90.001 },
    { ...candidate, lat: -90.001 }, { ...candidate, lon: 180.001 }, { ...candidate, lon: -180.001 },
    { ...candidate, address: privateAddress }, { ...candidate, region: { privateAddress } }];
  for (const value of malformed) {
    await assert.rejects(asUser(owner, () => rpc('update_home_location', [JSON.stringify(value), privateAddress])), /STILL_BAD_LOCATION/);
  }
  assert.deepEqual((await asUser(owner, () => rpc('get_home'))).location, saved, 'invalid writes leave the previous area intact');
  assert.deepEqual((await asUser(owner, () => rpc('update_home', [` ${privateAddress} `]))).location, saved,
    're-saving an unchanged address does not clear the selected area');
  const changed = await asUser(owner, () => rpc('update_home', ['이사한 곳의 다른 상세 주소']));
  assert.equal(changed.location, null);
  assert.equal(changed.neighborhood, '');
  assert.equal(changed.status, '우리 집 상태 미확인');
  assert.equal((await asUser(member, () => rpc('get_home'))).location, null);
  assert.equal((await asUser(member, () => rpc('get_home'))).address, undefined);
  await assert.rejects(asUser(owner, () => rpc('update_home_location', [candidate, privateAddress])), /STILL_HOME_CHANGED/,
    'an earlier provider lookup cannot restore the old location after an address edit');
  await assert.rejects(asUser(owner, () => rpc('update_home_location', [candidate, null])), /STILL_HOME_CHANGED/);
  assert.equal((await asUser(member, () => rpc('get_home'))).location, null);
  await asUser(owner, () => rpc('update_home_location', [{ ...candidate, lat: -90, lon: 180 }, '이사한 곳의 다른 상세 주소']));
  const cleared = await asUser(owner, () => rpc('update_home', ['']));
  assert.equal(cleared.location, null);
  assert.equal(cleared.hasAddress, false);
  assert.equal(cleared.status, '거주지 등록 대기');
  const permission = await db.query("select has_function_privilege('anon','public.still_update_home_location(jsonb,text)','execute') as anon, has_function_privilege('authenticated','public.still_update_home_location(jsonb,text)','execute') as member");
  assert.deepEqual(permission.rows[0], { anon: false, member: true });
  const oldPermission = await db.query("select has_function_privilege('anon','public.still_update_home_location(jsonb)','execute') as anon, has_function_privilege('authenticated','public.still_update_home_location(jsonb)','execute') as member");
  assert.deepEqual(oldPermission.rows[0], { anon: false, member: false });
  await assert.rejects(asUser(owner, () => rpc('update_home_location', [candidate])), /permission denied/);
});
