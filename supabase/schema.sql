-- Only the server-side service role can access player saves.
create schema if not exists srochnik_private;
revoke all on schema srochnik_private from public, anon, authenticated;
create table if not exists srochnik_private.saves (
  telegram_id text primary key,
  data jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table srochnik_private.saves enable row level security;
revoke all on srochnik_private.saves from public, anon, authenticated;

create or replace function public.srochnik_save(p_telegram_id text, p_mode text, p_data jsonb default null, p_revision bigint default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, srochnik_private as $$
declare row_data srochnik_private.saves%rowtype;
begin
  if p_mode = 'load' then
    select * into row_data from srochnik_private.saves where telegram_id = p_telegram_id;
  elsif p_mode = 'save' and p_data is not null and jsonb_typeof(p_data) = 'object' and octet_length(p_data::text) <= 131072 then
    if p_revision = 0 then
      insert into srochnik_private.saves (telegram_id, data) values (p_telegram_id, p_data)
      on conflict do nothing returning * into row_data;
    else
      update srochnik_private.saves set data = p_data, revision = revision + 1, updated_at = now()
      where telegram_id = p_telegram_id and revision = p_revision returning * into row_data;
    end if;
    if not found then return jsonb_build_object('conflict', true); end if;
  else
    raise exception 'invalid request';
  end if;
  if row_data.telegram_id is null then return jsonb_build_object('exists', false); end if;
  return jsonb_build_object('exists', true, 'revision', row_data.revision, 'data', row_data.data, 'updated_at', row_data.updated_at);
end $$;
revoke all on function public.srochnik_save(text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.srochnik_save(text, text, jsonb, bigint) to service_role;
