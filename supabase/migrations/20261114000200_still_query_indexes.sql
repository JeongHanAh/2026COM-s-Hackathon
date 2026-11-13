-- Performance-only follow-up: preserve existing grants and row visibility.
begin;

create index if not exists still_deletions_author on public.still_deletions(author_id);
create index if not exists still_deletions_family on public.still_deletions(family_id);
create index if not exists still_families_owner on public.still_families(owner_id);
create index if not exists still_homes_owner on public.still_homes(owner_id);

-- The caller's identity does not depend on the row. A scalar subquery lets
-- PostgreSQL evaluate it once per statement rather than once per row.
alter policy still_profile_read on public.still_profiles using
  (id=(select auth.uid()) or exists(select 1 from public.still_memberships where user_id=id and family_id=still_private.current_family()));
alter policy still_invite_owner_read on public.still_invitations using
  (exists(select 1 from public.still_families where id=family_id and owner_id=(select auth.uid())));
alter policy still_record_read on public.still_records using
  (family_id=still_private.current_family() and (status='ready' or (status='pending' and author_id=(select auth.uid()))));
alter policy still_home_owner_read on public.still_homes using(owner_id=(select auth.uid()));

commit;
