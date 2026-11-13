// PostgreSQL RLS/RPC verification. Auth and Storage schemas are fixtures only;
// the real migration and PostgreSQL privilege checks execute unchanged.
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export async function createPolicyDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,
      owner_id text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema auth,storage to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    grant select,insert,delete,update on storage.objects to authenticated;
  `);
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => /^\d+_.*\.sql$/.test(name)).sort()) {
    await db.exec(await readFile(new URL(name, migrations), 'utf8'));
  }
  const asUser = async (id, run, role = 'authenticated') => {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
    try { return await run(db); }
    finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
  };
  const rpc = async (name, values = []) => {
    const placeholders = values.map((_, i) => '$' + (i + 1)).join(',');
    return (await db.query(`select public.still_${name}(${placeholders}) as result`, values)).rows[0].result;
  };
  return { db, asUser, rpc };
}
