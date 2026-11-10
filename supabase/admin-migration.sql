-- Server-only roles, bans and audited administrative changes.
create table if not exists srochnik_private.admins (telegram_id text primary key);
create table if not exists srochnik_private.bans (telegram_id text primary key, created_at timestamptz not null default now());
create table if not exists srochnik_private.admin_audit (
  id bigint generated always as identity primary key,
  admin_id text not null, target_id text not null, action text not null,
  old_data jsonb, created_at timestamptz not null default now()
);
alter table srochnik_private.admins enable row level security;
alter table srochnik_private.bans enable row level security;
alter table srochnik_private.admin_audit enable row level security;
revoke all on srochnik_private.admins, srochnik_private.bans, srochnik_private.admin_audit from public, anon, authenticated;
insert into srochnik_private.admins (telegram_id) values ('1706627257') on conflict do nothing;

create or replace function public.srochnik_session_save(
  p_telegram_id text, p_session_id uuid, p_mode text,
  p_data jsonb default null, p_revision bigint default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, srochnik_private as $$
declare active_session uuid; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_telegram_id, 0));
  if exists (select 1 from srochnik_private.bans where telegram_id = p_telegram_id) then
    return jsonb_build_object('banned', true);
  end if;
  if p_mode = 'login' then
    insert into srochnik_private.sessions (telegram_id, session_id)
    values (p_telegram_id, p_session_id)
    on conflict (telegram_id) do update set session_id = excluded.session_id, updated_at = now();
    result := public.srochnik_save(p_telegram_id, 'load', null, null);
    return result || jsonb_build_object('is_admin', exists (select 1 from srochnik_private.admins where telegram_id = p_telegram_id));
  end if;
  select session_id into active_session from srochnik_private.sessions where telegram_id = p_telegram_id for update;
  if active_session is distinct from p_session_id then return jsonb_build_object('session_expired', true); end if;
  if p_mode not in ('load', 'save') then raise exception 'invalid request'; end if;
  return public.srochnik_save(p_telegram_id, p_mode, p_data, p_revision);
end $$;
revoke all on function public.srochnik_session_save(text, uuid, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.srochnik_session_save(text, uuid, text, jsonb, bigint) to service_role;

create or replace function public.srochnik_admin(p_actor text, p_session uuid, p_action text, p_target text default null, p_data jsonb default null, p_revision bigint default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, srochnik_private as $$
declare r srochnik_private.saves%rowtype; current_session uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_actor, 0));
  if not exists (select 1 from srochnik_private.admins where telegram_id = p_actor) then return jsonb_build_object('forbidden', true); end if;
  select session_id into current_session from srochnik_private.sessions where telegram_id = p_actor;
  if current_session is distinct from p_session then return jsonb_build_object('session_expired', true); end if;
  if exists (select 1 from srochnik_private.bans where telegram_id = p_actor) then return jsonb_build_object('forbidden', true); end if;
  if p_action = 'list' then
    return jsonb_build_object('players', coalesce((select jsonb_agg(x) from (select p.telegram_id, p.name, p.xp, exists(select 1 from srochnik_private.bans b where b.telegram_id=p.telegram_id) as banned from srochnik_private.players p order by p.updated_at desc limit 100) x), '[]'::jsonb));
  end if;
  if p_target is null or p_target !~ '^[0-9]{1,20}$' then return jsonb_build_object('invalid', true); end if;
  if p_target <> p_actor then perform pg_advisory_xact_lock(hashtextextended(p_target, 0)); end if;
  select * into r from srochnik_private.saves where telegram_id = p_target for update;
  if not found then return jsonb_build_object('not_found', true); end if;
  if p_action = 'get' then return jsonb_build_object('data', r.data, 'revision', r.revision, 'banned', exists(select 1 from srochnik_private.bans where telegram_id=p_target)); end if;
  if p_action = 'save' then
    if p_revision is distinct from r.revision then return jsonb_build_object('conflict', true); end if;
    if p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 131072 then return jsonb_build_object('invalid', true); end if;
    insert into srochnik_private.admin_audit(admin_id,target_id,action,old_data) values(p_actor,p_target,p_action,r.data);
    update srochnik_private.saves set data=p_data, revision=revision+1, updated_at=now() where telegram_id=p_target;
  elsif p_action in ('ban','unban') then
    if p_target = p_actor then return jsonb_build_object('invalid', true); end if;
    insert into srochnik_private.admin_audit(admin_id,target_id,action) values(p_actor,p_target,p_action);
    if p_action = 'ban' then insert into srochnik_private.bans(telegram_id) values(p_target) on conflict do nothing;
    else delete from srochnik_private.bans where telegram_id=p_target; end if;
  else return jsonb_build_object('invalid', true); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.srochnik_admin(text, uuid, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.srochnik_admin(text, uuid, text, text, jsonb, bigint) to service_role;
notify pgrst, 'reload schema';
