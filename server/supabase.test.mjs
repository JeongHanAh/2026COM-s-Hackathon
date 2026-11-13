import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRepository } from './supabase.mjs';

const url = 'https://example.supabase.co';
const key = 'sb_publishable_example';
const record = { id:'00000000-0000-4000-8000-000000000003', authorId:'00000000-0000-4000-8000-000000000002',
  storagePath:'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003.media',
  mimeType:'audio/mp4',sizeBytes:3 };

test('independent gateways use the same backend with each user JWT and no administrator key', async () => {
  const calls=[];
  const fetchImpl=async (target,options) => { calls.push({target,options}); return Response.json({user:{id:'user'},family:{id:'family'}}); };
  const first=createSupabaseRepository({url,key,fetchImpl}).forUser('jwt-A');
  const second=createSupabaseRepository({url,key,fetchImpl}).forUser('jwt-B');
  assert.deepEqual(await first.session(),await second.session());
  assert.equal(calls[0].target,url+'/rest/v1/rpc/still_session');
  assert.equal(calls[0].options.headers.Authorization,'Bearer jwt-A');
  assert.equal(calls[1].options.headers.Authorization,'Bearer jwt-B');
  assert.equal(calls[0].options.headers.apikey,key);
  assert.equal(calls[0].options.redirect,'error');
  assert.throws(()=>createSupabaseRepository({url,key:'sb_secret_never_distribute'}),/공개/);
  const serviceKey='header.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.sig';
  assert.throws(()=>createSupabaseRepository({url,key:serviceKey}),/관리 키/);
});

test('lost upload response retries immutable bytes; conflicting contents cannot overwrite', async () => {
  let existing=Buffer.from('abc'); let uploads=0;
  const fetchImpl=async (target,options)=>{
    if(options.method==='POST'){ uploads++; assert.equal(options.headers['x-upsert'],'false'); return Response.json({statusCode:'409',message:'The resource already exists'},{status:400}); }
    assert.match(target,/\/object\/authenticated\/still-recordings\//);
    return new Response(existing);
  };
  const repo=createSupabaseRepository({url,key,fetchImpl}).forUser('jwt-user');
  await repo.putObject(record,Buffer.from('abc'));
  existing=Buffer.from('xyz');
  await assert.rejects(repo.putObject(record,Buffer.from('abc')),error=>error.status===409&&error.code==='RECORD_CONFLICT');
  assert.equal(uploads,2);
});

test('SQL business errors are mapped without leaking response messages or tokens', async () => {
  let reply={error:'STILL_INVITE_RATE_LIMIT'};
  let status=200;
  const repo=createSupabaseRepository({url,key,fetchImpl:async()=>Response.json(reply,{status})}).forUser('jwt-user');
  await assert.rejects(repo.joinFamily('bad'),error=>error.status===429);
  reply={message:'STILL_RECORD_DELETED'};status=400;
  await assert.rejects(repo.finishRecord(record.id),error=>error.status===410&&error.code==='RECORD_DELETED');
  reply={message:'private SQL dump jwt-secret'};status=500;
  await assert.rejects(repo.listRecords(),error=>error.status===503&&!error.message.includes('jwt-secret'));
});

test('object downloads reject oversized payloads; paths cannot target another endpoint', async () => {
  const repo=createSupabaseRepository({url,key,fetchImpl:async()=>new Response('small',{headers:{'content-length':String(17*1024*1024)}})}).forUser('jwt-user');
  await assert.rejects(repo.readObject(record),error=>error.status===413);
  assert.throws(()=>repo.readObject({...record,storagePath:'../../auth/v1/user'}),error=>error.status===404);
});
