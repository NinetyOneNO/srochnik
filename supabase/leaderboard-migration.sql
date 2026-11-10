-- Player profiles and the public leaderboard.
-- Profiles are filled automatically from the save data by a trigger, so the
-- client never writes to the rating tables directly.
create table if not exists srochnik_private.players (
  telegram_id text primary key references srochnik_private.saves(telegram_id) on delete cascade,
  name text not null default 'Срочник',
  xp bigint not null default 0,
  contract boolean not null default false,
  service_days integer not null default 0,
  actions_total bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table srochnik_private.players enable row level security;
revoke all on srochnik_private.players from public, anon, authenticated;

create or replace function srochnik_private.sync_player()
returns trigger language plpgsql security definer
set search_path = pg_catalog, srochnik_private as $$
declare
  v_name text;
  v_xp bigint;
  v_contract boolean;
  v_actions bigint;
  v_started_ms numeric;
  v_days integer;
begin
  v_name := left(coalesce(nullif(btrim(new.data->>'name'), ''), 'Срочник'), 24);
  v_xp := least(1000000, case when new.data->>'xp' ~ '^[0-9]{1,12}$' then (new.data->>'xp')::bigint else 0 end);
  v_contract := new.data->>'contract' = 'true';
  v_actions := least(1000000, case when new.data->'stats'->>'actionsTotal' ~ '^[0-9]{1,12}$' then (new.data->'stats'->>'actionsTotal')::bigint else 0 end);
  v_started_ms := case when new.data->>'startedAt' ~ '^[0-9]{1,16}$' then (new.data->>'startedAt')::numeric else null end;
  v_days := case when v_started_ms is null then 0 else
    greatest(0, least(3650, floor((extract(epoch from now()) - v_started_ms / 1000) / 43200)::integer))
  end;

  insert into srochnik_private.players (telegram_id, name, xp, contract, service_days, actions_total, updated_at)
  values (new.telegram_id, v_name, v_xp, v_contract, v_days, v_actions, now())
  on conflict (telegram_id) do update set
    name = excluded.name,
    xp = excluded.xp,
    contract = excluded.contract,
    service_days = excluded.service_days,
    actions_total = excluded.actions_total,
    updated_at = now();
  return new;
end $$;
revoke all on function srochnik_private.sync_player() from public, anon, authenticated;

drop trigger if exists sync_player_after_save on srochnik_private.saves;
create trigger sync_player_after_save
after insert or update of data on srochnik_private.saves
for each row execute function srochnik_private.sync_player();

-- Backfill profiles for saves that already exist.
insert into srochnik_private.players (telegram_id, name, xp, contract, service_days, actions_total, updated_at)
select
  s.telegram_id,
  left(coalesce(nullif(btrim(s.data->>'name'), ''), 'Срочник'), 24),
  case when s.data->>'xp' ~ '^[0-9]{1,12}$' then least(1000000, (s.data->>'xp')::bigint) else 0 end,
  s.data->>'contract' = 'true',
  case when s.data->>'startedAt' ~ '^[0-9]{1,16}$' then
    greatest(0, least(3650, floor((extract(epoch from now()) - (s.data->>'startedAt')::numeric / 1000) / 43200)::integer))
  else 0 end,
  case when s.data->'stats'->>'actionsTotal' ~ '^[0-9]{1,12}$' then least(1000000, (s.data->'stats'->>'actionsTotal')::bigint) else 0 end,
  s.updated_at
from srochnik_private.saves s
on conflict (telegram_id) do update set
  name = excluded.name,
  xp = excluded.xp,
  contract = excluded.contract,
  service_days = excluded.service_days,
  actions_total = excluded.actions_total,
  updated_at = excluded.updated_at;

create or replace function public.srochnik_leaderboard(p_telegram_id text, p_limit integer default 50)
returns jsonb language sql security definer
set search_path = pg_catalog, srochnik_private as $$
with ranked as (
  select telegram_id, name, xp, contract, service_days, actions_total, updated_at,
    row_number() over (order by xp desc, service_days desc, actions_total desc, updated_at asc, telegram_id asc) as place
  from srochnik_private.players
), top as (
  select * from ranked order by place
  limit greatest(1, least(coalesce(p_limit, 50), 100))
)
select jsonb_build_object(
  'players', coalesce((select jsonb_agg(jsonb_build_object(
    'place', place,
    'name', name,
    'xp', xp,
    'contract', contract,
    'serviceDays', service_days,
    'actions', actions_total,
    'isMe', telegram_id = p_telegram_id
  ) order by place) from top), '[]'::jsonb),
  'total', (select count(*) from ranked),
  'me', (select jsonb_build_object(
    'place', place,
    'name', name,
    'xp', xp,
    'contract', contract,
    'serviceDays', service_days,
    'actions', actions_total
  ) from ranked where telegram_id = p_telegram_id)
);
$$;
revoke all on function public.srochnik_leaderboard(text, integer) from public, anon, authenticated;
grant execute on function public.srochnik_leaderboard(text, integer) to service_role;

notify pgrst, 'reload schema';
