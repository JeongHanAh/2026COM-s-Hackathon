-- Still: managed authentication, family isolation and private recordings.
-- Apply once through Supabase migrations / SQL editor. No demo users or records.
begin;

create schema if not exists still_private;
revoke all on schema still_private from public, anon, authenticated;
grant usage on schema still_private to authenticated;

create table if not exists public.still_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  created_at timestamptz not null default now()
);
create table if not exists public.still_families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner_id uuid not null references public.still_profiles(id),
  created_at timestamptz not null default now()
);
create table if not exists public.still_memberships (
  family_id uuid not null references public.still_families(id) on delete cascade,
  user_id uuid not null unique references public.still_profiles(id) on delete cascade,
  role text not null check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (family_id,user_id)
);
create table if not exists public.still_invitations (
  family_id uuid primary key references public.still_families(id) on delete cascade,
  code text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.still_join_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started timestamptz not null default now(),
  attempts integer not null default 0
);
create table if not exists public.still_records (
  id uuid primary key,
  family_id uuid not null references public.still_families(id) on delete cascade,
  author_id uuid not null references public.still_profiles(id),
  kind text not null check (kind in ('video','audio')),
  captured_at timestamptz not null,
  uploaded_at timestamptz,
  updated_at timestamptz,
  duration_ms integer not null check (duration_ms between 1 and 10250),
  mime_type text not null,
  size_bytes integer not null check (size_bytes between 1 and 16777216),
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending','ready','deleted')),
  transcript text check (char_length(transcript) <= 5000),
  transcript_status text check (transcript_status in ('processing','ready','failed')),
  created_at timestamptz not null default now()
);
create index if not exists still_records_family_date on public.still_records(family_id,captured_at desc);
create index if not exists still_records_author on public.still_records(author_id);
create table if not exists public.still_deletions (
  id uuid primary key,
  family_id uuid not null references public.still_families(id) on delete cascade,
  author_id uuid not null references public.still_profiles(id),
  storage_path text,
  created_at timestamptz not null default now()
);
create table if not exists public.still_homes (
  family_id uuid primary key references public.still_families(id) on delete cascade,
  owner_id uuid not null references public.still_profiles(id),
  address text not null default '' check (char_length(address) <= 300)
);

alter table public.still_profiles enable row level security;
alter table public.still_families enable row level security;
alter table public.still_memberships enable row level security;
alter table public.still_invitations enable row level security;
alter table public.still_join_attempts enable row level security;
alter table public.still_records enable row level security;
alter table public.still_deletions enable row level security;
alter table public.still_homes enable row level security;

create or replace function still_private.current_family() returns uuid
language sql stable security definer set search_path = '' as $$
  select family_id from public.still_memberships where user_id = (select auth.uid());
$$;

create or replace function still_private.require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid := auth.uid();
begin
  if v_id is null or not exists (
    select 1 from auth.users where id = v_id and email_confirmed_at is not null
  ) then raise exception 'STILL_AUTH_REQUIRED'; end if;
  return v_id;
end;
$$;

create or replace function still_private.require_family() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform still_private.require_user();
  v_id := still_private.current_family();
  if v_id is null then raise exception 'STILL_FAMILY_REQUIRED'; end if;
  return v_id;
end;
$$;

create or replace function still_private.ensure_profile() returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := still_private.require_user(); v_name text;
begin
  select left(coalesce(nullif(btrim(raw_user_meta_data->>'name'),''),'멤버'),60)
    into v_name from auth.users where id = v_id;
  insert into public.still_profiles(id,display_name) values(v_id,v_name) on conflict(id) do nothing;
end;
$$;

create or replace function still_private.record_json(r public.still_records) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',r.id,'familyId',r.family_id,'authorId',r.author_id,
    'authorName',(select display_name from public.still_profiles where id=r.author_id),
    'kind',r.kind,'capturedAt',r.captured_at,'uploadedAt',r.uploaded_at,'updatedAt',r.updated_at,
    'durationMs',r.duration_ms,'mimeType',r.mime_type,'sizeBytes',r.size_bytes,
    'storagePath',r.storage_path,'status',r.status,'transcript',r.transcript,
    'transcriptStatus',r.transcript_status,'mediaUrl','/api/records/'||r.id::text||'/media');
$$;

create or replace function public.still_session() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := still_private.require_user(); v_family uuid; v_role text; v_name text; v_family_json jsonb;
begin
  perform still_private.ensure_profile();
  select display_name into v_name from public.still_profiles where id=v_user;
  select family_id,role into v_family,v_role from public.still_memberships where user_id=v_user;
  if v_family is not null then
    select jsonb_build_object('id',f.id,'name',f.name,'members',(
      select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'role',m.role) order by m.joined_at,p.id),'[]'::jsonb)
      from public.still_memberships m join public.still_profiles p on p.id=m.user_id where m.family_id=v_family
    )) into v_family_json from public.still_families f where f.id=v_family;
    if v_role='owner' then
      v_family_json := v_family_json || coalesce((select jsonb_build_object('inviteCode',code,'inviteExpiresAt',expires_at)
        from public.still_invitations where family_id=v_family),'{}'::jsonb);
    end if;
  end if;
  return jsonb_build_object('user',jsonb_build_object('id',v_user,'name',v_name,'role',v_role,'member',v_family is not null),
    'family',v_family_json,'demo',false,'backend','supabase','auth',jsonb_build_object('signup',true,'recovery',true));
end;
$$;

create or replace function public.still_create_family(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := still_private.require_user(); v_family uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,1));
  perform still_private.ensure_profile();
  if still_private.current_family() is not null then raise exception 'STILL_ALREADY_MEMBER'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 60 then raise exception 'STILL_BAD_FAMILY'; end if;
  insert into public.still_families(name,owner_id) values(btrim(p_name),v_user) returning id into v_family;
  insert into public.still_memberships values(v_family,v_user,'owner',now());
  insert into public.still_invitations(family_id,code,expires_at)
    values(v_family,upper(replace(gen_random_uuid()::text,'-','')),now()+interval '7 days');
  insert into public.still_homes(family_id,owner_id) values(v_family,v_user);
  return public.still_session();
end;
$$;

create or replace function public.still_join_family(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := still_private.require_user(); v_family uuid; v_attempt public.still_join_attempts;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text,1));
  perform still_private.ensure_profile();
  if still_private.current_family() is not null then raise exception 'STILL_ALREADY_MEMBER'; end if;
  insert into public.still_join_attempts(user_id) values(v_user) on conflict(user_id) do nothing;
  select * into v_attempt from public.still_join_attempts where user_id=v_user for update;
  if v_attempt.window_started < now()-interval '15 minutes' then
    update public.still_join_attempts set attempts=0,window_started=now() where user_id=v_user;
    v_attempt.attempts:=0;
  end if;
  if v_attempt.attempts>=10 then return jsonb_build_object('error','STILL_INVITE_RATE_LIMIT'); end if;
  update public.still_join_attempts set attempts=attempts+1 where user_id=v_user;
  select family_id into v_family from public.still_invitations
    where code=upper(btrim(p_code)) and expires_at>now();
  -- Return errors rather than raising so unsuccessful-attempt counters commit.
  if v_family is null then return jsonb_build_object('error','STILL_INVITE_INVALID'); end if;
  perform 1 from public.still_families where id=v_family for update;
  if not exists(select 1 from public.still_invitations where family_id=v_family and code=upper(btrim(p_code)) and expires_at>now())
    then return jsonb_build_object('error','STILL_INVITE_INVALID'); end if;
  if (select count(*) from public.still_memberships where family_id=v_family)>=32
    then return jsonb_build_object('error','STILL_FAMILY_FULL'); end if;
  insert into public.still_memberships values(v_family,v_user,'member',now());
  delete from public.still_join_attempts where user_id=v_user;
  return public.still_session();
end;
$$;

create or replace function public.still_rotate_invite() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_family uuid := still_private.require_family();
begin
  perform 1 from public.still_families where id=v_family for update;
  if not exists(select 1 from public.still_families where id=v_family and owner_id=auth.uid())
    then raise exception 'STILL_OWNER_REQUIRED'; end if;
  update public.still_invitations set code=upper(replace(gen_random_uuid()::text,'-','')),
    expires_at=now()+interval '7 days',created_at=now() where family_id=v_family;
  return public.still_session();
end;
$$;

create or replace function public.still_list_records() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_family uuid := still_private.require_family();
begin
  return (select coalesce(jsonb_agg(still_private.record_json(r) order by r.captured_at,r.id),'[]'::jsonb)
    from public.still_records r where family_id=v_family and status='ready');
end;
$$;

create or replace function public.still_get_record(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_family uuid := still_private.require_family(); v_record public.still_records;
begin
  select * into v_record from public.still_records where id=p_id and family_id=v_family
    and (status='ready' or (status='pending' and author_id=auth.uid()));
  if not found then return null; end if;
  return still_private.record_json(v_record);
end;
$$;

create or replace function public.still_reserve_record(p_id uuid,p_kind text,p_captured_at timestamptz,
  p_duration_ms integer,p_mime_type text,p_size_bytes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := still_private.require_user(); v_family uuid := still_private.require_family();
  v_record public.still_records; v_count bigint; v_bytes bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text,2));
  if exists(select 1 from public.still_deletions where id=p_id) then raise exception 'STILL_RECORD_DELETED'; end if;
  select * into v_record from public.still_records where id=p_id for update;
  if found then
    if v_record.author_id<>v_user or v_record.family_id<>v_family then raise exception 'STILL_RECORD_CONFLICT'; end if;
    if v_record.status='deleted' then raise exception 'STILL_RECORD_DELETED'; end if;
    if (v_record.kind,v_record.captured_at,v_record.duration_ms,v_record.mime_type,v_record.size_bytes)
      is distinct from (p_kind,p_captured_at,p_duration_ms,p_mime_type,p_size_bytes)
      then raise exception 'STILL_RECORD_CONFLICT'; end if;
    return still_private.record_json(v_record);
  end if;
  if p_id is null or p_kind is null or p_kind not in ('video','audio') or p_captured_at is null
    or p_captured_at > now()+interval '5 minutes' or p_captured_at < '1900-01-01'::timestamptz
    or p_duration_ms is null or p_size_bytes is null or p_size_bytes not between 1 and 16777216
    or (p_kind='audio' and (p_duration_ms not between 1 and 10250 or p_mime_type not in ('audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/wav','audio/x-m4a')))
    or (p_kind='video' and (p_duration_ms not between 1500 and 4500 or p_mime_type not in ('video/webm','video/mp4','video/ogg','video/quicktime')))
    or p_mime_type is null then raise exception 'STILL_BAD_RECORD'; end if;
  -- Serialize all reservations in this family so count/byte quotas cannot be raced.
  perform 1 from public.still_families where id=v_family for update;
  -- Reserve the bucket's maximum per unfinished upload. Storage's authorization
  -- probe runs before bytes are known, so a caller's declared size is not a quota
  -- boundary until finish_record verifies the immutable object's actual size.
  -- Tombstoned objects still consume quota until physical cleanup succeeds.
  select count(*),coalesce(sum(case when r.status='ready' then r.size_bytes else 16777216 end),0)
    into v_count,v_bytes from public.still_records r
    where r.author_id=v_user and (r.status in ('pending','ready') or exists(
      select 1 from storage.objects o where o.bucket_id='still-recordings' and o.name=r.storage_path));
  if v_count>=1000 or v_bytes+16777216>268435456 then raise exception 'STILL_STORAGE_QUOTA'; end if;
  select count(*),coalesce(sum(case when r.status='ready' then r.size_bytes else 16777216 end),0)
    into v_count,v_bytes from public.still_records r
    where r.family_id=v_family and (r.status in ('pending','ready') or exists(
      select 1 from storage.objects o where o.bucket_id='still-recordings' and o.name=r.storage_path));
  if v_count>=2000 or v_bytes+16777216>1073741824 then raise exception 'STILL_STORAGE_QUOTA'; end if;
  insert into public.still_records(id,family_id,author_id,kind,captured_at,duration_ms,mime_type,size_bytes,storage_path,transcript_status)
    values(p_id,v_family,v_user,p_kind,p_captured_at,p_duration_ms,p_mime_type,p_size_bytes,
      v_family::text||'/'||v_user::text||'/'||p_id::text||'.media',case when p_kind='audio' then 'processing' else null end)
    returning * into v_record;
  return still_private.record_json(v_record);
end;
$$;

create or replace function public.still_finish_record(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := still_private.require_user(); v_family uuid := still_private.require_family(); v_record public.still_records; v_now timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text,2));
  if exists(select 1 from public.still_deletions where id=p_id) then raise exception 'STILL_RECORD_DELETED'; end if;
  select * into v_record from public.still_records where id=p_id for update;
  if not found or v_record.author_id<>v_user or v_record.family_id<>v_family then raise exception 'STILL_RECORD_MISSING'; end if;
  if v_record.status='deleted' then raise exception 'STILL_RECORD_DELETED'; end if;
  if v_record.status='ready' then return still_private.record_json(v_record); end if;
  if not exists(select 1 from storage.objects where bucket_id='still-recordings' and name=v_record.storage_path
    and (metadata->>'size')::bigint=v_record.size_bytes) then raise exception 'STILL_UPLOAD_INCOMPLETE'; end if;
  v_now:=clock_timestamp();
  update public.still_records set status='ready',uploaded_at=v_now,updated_at=v_now
    where id=p_id returning * into v_record;
  return still_private.record_json(v_record);
end;
$$;

create or replace function public.still_delete_record(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := still_private.require_user(); v_family uuid := still_private.require_family();
  v_record public.still_records; v_deleted public.still_deletions;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text,2));
  select * into v_record from public.still_records where id=p_id for update;
  select * into v_deleted from public.still_deletions where id=p_id;
  if (v_record.id is not null and (v_record.author_id<>v_user or v_record.family_id<>v_family))
    or (v_deleted.id is not null and (v_deleted.author_id<>v_user or v_deleted.family_id<>v_family))
    then raise exception 'STILL_DELETE_FORBIDDEN'; end if;
  insert into public.still_deletions(id,family_id,author_id,storage_path) values(p_id,v_family,v_user,v_record.storage_path)
    on conflict(id) do nothing;
  if v_record.id is null then return null; end if;
  update public.still_records set status='deleted',transcript=null,transcript_status=null where id=p_id returning * into v_record;
  return still_private.record_json(v_record);
end;
$$;

create or replace function public.still_set_transcript(p_id uuid,p_text text,p_automatic boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_family uuid := still_private.require_family(); v_record public.still_records; v_text text := nullif(btrim(p_text),'');
begin
  select * into v_record from public.still_records where id=p_id and family_id=v_family and status='ready' for update;
  if not found then raise exception 'STILL_RECORD_MISSING'; end if;
  if v_record.kind<>'audio' or char_length(v_text)>5000 or (not p_automatic and v_text is null)
    then raise exception 'STILL_BAD_TRANSCRIPT'; end if;
  if p_automatic then
    if v_record.transcript_status<>'processing' then return still_private.record_json(v_record); end if;
  end if;
  update public.still_records set transcript=v_text,transcript_status=case when v_text is null then 'failed' else 'ready' end,
    updated_at=case when not p_automatic and (transcript is distinct from v_text or transcript_status<>'ready') then clock_timestamp() else updated_at end
    where id=p_id returning * into v_record;
  return still_private.record_json(v_record);
end;
$$;

create or replace function public.still_get_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_family uuid := still_private.require_family(); v_home public.still_homes; v_result jsonb;
begin
  select * into v_home from public.still_homes where family_id=v_family;
  v_result:=jsonb_build_object('neighborhood','가자시 알샤티 · 시연 자료','dataset','demo','canEdit',v_home.owner_id=auth.uid(),
    'hasAddress',v_home.address<>'','status',case when v_home.address<>'' then '우리 집 상태 미확인 · 지도는 시연 자료' else '거주지 등록 대기' end,
    'buildingObservation',null);
  if v_home.owner_id=auth.uid() then v_result:=v_result||jsonb_build_object('address',v_home.address); end if;
  return v_result;
end;
$$;

create or replace function public.still_update_home(p_address text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_family uuid := still_private.require_family();
begin
  if not exists(select 1 from public.still_homes where family_id=v_family and owner_id=auth.uid())
    then raise exception 'STILL_OWNER_REQUIRED'; end if;
  if p_address is null or char_length(btrim(p_address))>300 then raise exception 'STILL_BAD_ADDRESS'; end if;
  update public.still_homes set address=btrim(p_address) where family_id=v_family;
  return public.still_get_home();
end;
$$;

-- Serialize the caller-policy check with record deletion. Supabase Storage may
-- probe RLS in a rolled-back savepoint before its privileged final write, so the
-- gateway must also recheck finalization and retry physical object cleanup.
create or replace function still_private.can_upload(p_path text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_record public.still_records;
begin
  select * into v_record from public.still_records where storage_path=p_path for update;
  return found and v_record.author_id=auth.uid() and v_record.family_id=still_private.current_family()
    and v_record.status='pending' and not exists(select 1 from public.still_deletions where id=v_record.id);
end;
$$;
create or replace function still_private.can_read_object(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.still_records where storage_path=p_path and family_id=still_private.current_family()
    and (status='ready' or (status in ('pending','deleted') and author_id=auth.uid())));
$$;
create or replace function still_private.can_delete_object(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.still_deletions where storage_path=p_path and author_id=auth.uid() and family_id=still_private.current_family());
$$;

revoke all on public.still_profiles,public.still_families,public.still_memberships,public.still_invitations,
  public.still_join_attempts,public.still_records,public.still_deletions,public.still_homes from public,anon,authenticated;
grant select on public.still_profiles,public.still_families,public.still_memberships,public.still_invitations,
  public.still_records,public.still_homes to authenticated;

create policy still_profile_read on public.still_profiles for select to authenticated using
  (id=auth.uid() or exists(select 1 from public.still_memberships where user_id=id and family_id=still_private.current_family()));
create policy still_family_read on public.still_families for select to authenticated using(id=still_private.current_family());
create policy still_members_read on public.still_memberships for select to authenticated using(family_id=still_private.current_family());
create policy still_invite_owner_read on public.still_invitations for select to authenticated using
  (exists(select 1 from public.still_families where id=family_id and owner_id=auth.uid()));
create policy still_record_read on public.still_records for select to authenticated using
  (family_id=still_private.current_family() and (status='ready' or (status='pending' and author_id=auth.uid())));
create policy still_home_owner_read on public.still_homes for select to authenticated using(owner_id=auth.uid());

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('still-recordings','still-recordings',false,16777216,array['audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/wav','audio/x-m4a','video/webm','video/mp4','video/ogg','video/quicktime'])
  on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy still_object_read on storage.objects for select to authenticated using
  (bucket_id='still-recordings' and still_private.can_read_object(name));
-- Storage's remove API needs SELECT as well as DELETE. Only the original author
-- may see a tombstoned object until physical cleanup succeeds. Other members lose
-- access at tombstone commit; the API does not acknowledge deletion until removal.
create policy still_object_insert on storage.objects for insert to authenticated with check
  (bucket_id='still-recordings' and still_private.can_upload(name));
create policy still_object_delete on storage.objects for delete to authenticated using
  (bucket_id='still-recordings' and still_private.can_delete_object(name));

-- Storage is shared by all applications in a Supabase project. Permissive policies
-- combine with OR, so another application's broad policy must not expose Still.
-- Restrictive guards affect only this bucket and keep objects immutable.
create policy still_object_read_guard on storage.objects as restrictive for select to authenticated using
  (case when bucket_id<>'still-recordings' then true when auth.uid() is null then false else still_private.can_read_object(name) end);
create policy still_object_insert_guard on storage.objects as restrictive for insert to authenticated with check
  (case when bucket_id<>'still-recordings' then true when auth.uid() is null then false else still_private.can_upload(name) end);
create policy still_object_delete_guard on storage.objects as restrictive for delete to authenticated using
  (case when bucket_id<>'still-recordings' then true when auth.uid() is null then false else still_private.can_delete_object(name) end);
create policy still_object_update_guard on storage.objects as restrictive for update to public using
  (bucket_id<>'still-recordings') with check (bucket_id<>'still-recordings');
create policy still_object_anonymous_guard on storage.objects as restrictive for all to anon using
  (bucket_id<>'still-recordings') with check (bucket_id<>'still-recordings');

-- Revoke the default PUBLIC function execution privilege, including helper RPCs.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature,n.nspname as schema_name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='still_private' or (n.nspname='public' and p.proname like 'still\_%' escape '\')
  loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    if f.schema_name='public' then
      execute format('grant execute on function %s to authenticated',f.signature);
    end if;
  end loop;
end $$;
grant execute on function still_private.current_family(),still_private.can_upload(text),
  still_private.can_read_object(text),still_private.can_delete_object(text) to authenticated;

commit;
