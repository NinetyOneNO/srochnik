-- Avatars in the leaderboard.
-- Run once in the Supabase SQL Editor after leaderboard-migration.sql.
-- The client sends a small JPEG copy (avatarMini, 96x96) in the save data;
-- the public leaderboard only exposes that small copy.

alter table srochnik_private.players
  add column if not exists avatar text not null default '';

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
  v_avatar text;
begin
  v_name := left(coalesce(nullif(btrim(new.data->>'name'), ''), 'Срочник'), 24);
  v_xp := least(1000000, case when new.data->>'xp' ~ '^[0-9]{1,12}$' then (new.data->>'xp')::bigint else 0 end);
  v_contract := new.data->>'contract' = 'true';
  v_actions := least(1000000, case when new.data->'stats'->>'actionsTotal' ~ '^[0-9]{1,12}$' then (new.data->'stats'->>'actionsTotal')::bigint else 0 end);
  v_started_ms := case when new.data->>'startedAt' ~ '^[0-9]{1,16}$' then (new.data->>'startedAt')::numeric else null end;
  v_days := case when v_started_ms is null then 0 else
    greatest(0, least(3650, floor((extract(epoch from now()) - v_started_ms / 1000) / 43200)::integer))
  end;

  -- Only accept a short inline image; anything else is dropped silently.
  v_avatar := coalesce(nullif(new.data->>'avatarMini', ''), nullif(new.data->>'avatar', ''), '');
  if length(v_avatar) > 40000
     or v_avatar !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then
    v_avatar := '';
  end if;

  insert into srochnik_private.players (telegram_id, name, xp, contract, service_days, actions_total, avatar, updated_at)
  values (new.telegram_id, v_name, v_xp, v_contract, v_days, v_actions, v_avatar, now())
  on conflict (telegram_id) do update set
    name = excluded.name,
    xp = excluded.xp,
    contract = excluded.contract,
    service_days = excluded.service_days,
    actions_total = excluded.actions_total,
    avatar = excluded.avatar,
    updated_at = now();
  return new;
end $$;
revoke all on function srochnik_private.sync_player() from public, anon, authenticated;

-- Backfill avatars for profiles that already exist.
update srochnik_private.players p
set avatar = coalesce(nullif(s.data->>'avatarMini', ''), nullif(s.data->>'avatar', ''), '')
from srochnik_private.saves s
where s.telegram_id = p.telegram_id
  and length(coalesce(nullif(s.data->>'avatarMini', ''), nullif(s.data->>'avatar', ''), '')) <= 40000
  and coalesce(nullif(s.data->>'avatarMini', ''), nullif(s.data->>'avatar', ''), '') ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$';

create or replace function public.srochnik_leaderboard(p_telegram_id text, p_limit integer default 50)
returns jsonb language sql security definer
set search_path = pg_catalog, srochnik_private as $$
with ranked as (
  select telegram_id, name, xp, contract, service_days, actions_total, avatar, updated_at,
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
    'avatar', avatar,
    'isMe', telegram_id = p_telegram_id
  ) order by place) from top), '[]'::jsonb),
  'total', (select count(*) from ranked),
  'me', (select jsonb_build_object(
    'place', place,
    'name', name,
    'xp', xp,
    'contract', contract,
    'serviceDays', service_days,
    'actions', actions_total,
    'avatar', avatar
  ) from ranked where telegram_id = p_telegram_id)
);
$$;
revoke all on function public.srochnik_leaderboard(text, integer) from public, anon, authenticated;
grant execute on function public.srochnik_leaderboard(text, integer) to service_role;

notify pgrst, 'reload schema';
