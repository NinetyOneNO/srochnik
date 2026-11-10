-- Session checks and writes share the same row lock, so an old session cannot
-- write after a newer session has acquired ownership.
create table if not exists srochnik_private.sessions (
  telegram_id text primary key,
  session_id uuid not null,
  updated_at timestamptz not null default now()
);
alter table srochnik_private.sessions enable row level security;
revoke all on srochnik_private.sessions from public, anon, authenticated;

create or replace function public.srochnik_session_save(
  p_telegram_id text, p_session_id uuid, p_mode text,
  p_data jsonb default null, p_revision bigint default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, srochnik_private as $$
declare active_session uuid; result jsonb;
begin
  if p_mode = 'login' then
    insert into srochnik_private.sessions (telegram_id, session_id)
    values (p_telegram_id, p_session_id)
    on conflict (telegram_id) do update set session_id = excluded.session_id, updated_at = now();
    return public.srochnik_save(p_telegram_id, 'load', null, null);
  end if;
  select session_id into active_session from srochnik_private.sessions
    where telegram_id = p_telegram_id for update;
  if active_session is distinct from p_session_id then
    return jsonb_build_object('session_expired', true);
  end if;
  if p_mode not in ('load', 'save') then raise exception 'invalid request'; end if;
  return public.srochnik_save(p_telegram_id, p_mode, p_data, p_revision);
end $$;
revoke all on function public.srochnik_session_save(text, uuid, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.srochnik_session_save(text, uuid, text, jsonb, bigint) to service_role;
