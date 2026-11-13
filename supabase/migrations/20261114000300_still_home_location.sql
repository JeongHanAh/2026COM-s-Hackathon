-- Upgrade an existing Still project after the two earlier migrations.
-- Existing homes and private addresses are preserved; no location is inferred.
-- Generated with `supabase migration new still_home_location`, then ordered
-- after the existing baseline (whose filenames use the following local date).
begin;

alter table public.still_homes add column if not exists location jsonb;

create or replace function public.still_get_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_family uuid := still_private.require_family(); v_home public.still_homes; v_result jsonb;
begin
  select * into v_home from public.still_homes where family_id=v_family;
  v_result:=jsonb_build_object('neighborhood',coalesce(v_home.location->>'region',''),
    'location',v_home.location,'canEdit',v_home.owner_id=auth.uid(),
    'hasAddress',v_home.address<>'','status',case when v_home.address<>'' or v_home.location is not null
      then '우리 집 상태 미확인' else '거주지 등록 대기' end,'buildingObservation',null);
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
  -- Evaluate against the same locked row as the address write. Re-saving the
  -- unchanged address retains the chosen area; a different address clears it.
  update public.still_homes set
    location=case when address is distinct from btrim(p_address) then null else location end,
    address=btrim(p_address) where family_id=v_family;
  return public.still_get_home();
end;
$$;

-- Disable the first revision without dropping a deployed function. It cannot
-- bypass the address comparison even if a future grant accidentally exposes it.
create or replace function public.still_update_home_location(p_location jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'STILL_HOME_CHANGED';
end;
$$;
revoke all on function public.still_update_home_location(jsonb) from public,anon,authenticated;
create or replace function public.still_update_home_location(p_location jsonb,p_expected_address text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_family uuid := still_private.require_family();
  v_key text; v_value text; v_limit integer;
  v_lat numeric; v_lon numeric; v_location jsonb;
begin
  if not exists(select 1 from public.still_homes where family_id=v_family and owner_id=auth.uid())
    then raise exception 'STILL_OWNER_REQUIRED'; end if;
  if p_location is null or jsonb_typeof(p_location)<>'object' or octet_length(p_location::text)>2048
    then raise exception 'STILL_BAD_LOCATION'; end if;
  if not (p_location ?& array['id','label','region','lat','lon','newsQuery'])
    or exists(select 1 from jsonb_object_keys(p_location) as keys(key)
      where key not in ('id','label','region','lat','lon','newsQuery'))
    then raise exception 'STILL_BAD_LOCATION'; end if;
  foreach v_key in array array['id','label','region','newsQuery'] loop
    if jsonb_typeof(p_location->v_key)<>'string' then raise exception 'STILL_BAD_LOCATION'; end if;
    v_value:=btrim(p_location->>v_key);
    v_limit:=case v_key when 'id' then 120 when 'region' then 160 else 200 end;
    if char_length(v_value) not between 1 and v_limit or v_value ~ '[[:cntrl:]]'
      then raise exception 'STILL_BAD_LOCATION'; end if;
  end loop;
  if jsonb_typeof(p_location->'lat')<>'number' or jsonb_typeof(p_location->'lon')<>'number'
    then raise exception 'STILL_BAD_LOCATION'; end if;
  v_lat:=(p_location->>'lat')::numeric;
  v_lon:=(p_location->>'lon')::numeric;
  if v_lat not between -90 and 90 or v_lon not between -180 and 180
    then raise exception 'STILL_BAD_LOCATION'; end if;
  -- Store only a rounded area centroid. No external geocoding response or
  -- additional address fields can be smuggled into the family-visible object.
  v_location:=jsonb_build_object('id',btrim(p_location->>'id'),'label',btrim(p_location->>'label'),
    'region',btrim(p_location->>'region'),'newsQuery',btrim(p_location->>'newsQuery'),
    'lat',round(v_lat,2),'lon',round(v_lon,2));
  -- An address edit can finish while the provider resolves an earlier choice.
  -- Compare within the UPDATE's row lock, not only before external I/O.
  update public.still_homes set location=v_location
    where family_id=v_family and owner_id=auth.uid() and address=p_expected_address;
  if not found then raise exception 'STILL_HOME_CHANGED'; end if;
  return public.still_get_home();
end;
$$;

-- Keep raw home rows owner-only. Family members receive the explicit safe
-- projection above; a new function must not inherit PUBLIC's EXECUTE default.
revoke all on function public.still_get_home(),public.still_update_home(text),
  public.still_update_home_location(jsonb,text) from public,anon,authenticated;
grant execute on function public.still_get_home(),public.still_update_home(text),
  public.still_update_home_location(jsonb,text) to authenticated;

commit;
