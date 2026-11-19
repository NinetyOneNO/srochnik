-- Requires the existing leaderboard, session and admin migrations, and pg_cron.
-- Installs a weekly snapshot on Monday 00:00 UTC. No past weeks are backfilled.
begin;
create extension if not exists pg_cron;

create table if not exists srochnik_private.weekly_rewards (
  week_start date not null,
  telegram_id text not null,
  place integer not null check (place between 1 and 3),
  amount integer not null check (amount > 0),
  claimed_at timestamptz,
  primary key (week_start, telegram_id),
  unique (week_start, place)
);
alter table srochnik_private.weekly_rewards enable row level security;
revoke all on srochnik_private.weekly_rewards from public, anon, authenticated;

create table if not exists srochnik_private.weekly_reward_snapshots (
  week_start date primary key,
  created_at timestamptz not null default now()
);
alter table srochnik_private.weekly_reward_snapshots enable row level security;
revoke all on srochnik_private.weekly_reward_snapshots from public, anon, authenticated;

create or replace function srochnik_private.snapshot_weekly_rewards()
returns void language plpgsql security definer
set search_path = pg_catalog, srochnik_private as $$
declare v_week date := (date_trunc('week', now() at time zone 'UTC') - interval '7 days')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended('srochnik_weekly_snapshot', 0));
  insert into srochnik_private.weekly_reward_snapshots (week_start) values (v_week)
    on conflict do nothing;
  if not found then return; end if;
  insert into srochnik_private.weekly_rewards (week_start, telegram_id, place, amount)
  select v_week, ranked.telegram_id, ranked.place::integer,
    case ranked.place when 1 then 100 when 2 then 70 else 50 end
  from (
    select p.telegram_id, row_number() over (
      order by p.xp desc, p.service_days desc, p.actions_total desc, p.updated_at asc, p.telegram_id asc
    ) as place
    from srochnik_private.players p
    join srochnik_private.saves s on s.telegram_id = p.telegram_id
    where not exists (select 1 from srochnik_private.bans b where b.telegram_id = p.telegram_id)
      and case when s.data->'streak'->>'count' ~ '^[0-9]{1,9}$'
        then (s.data->'streak'->>'count')::integer >= 7 else false end
      -- The client records calendar dates in the player's local timezone.
      and s.data->'streak'->>'lastDate' in (
        to_char(now() at time zone 'UTC', 'YYYY-MM-DD'),
        to_char((now() at time zone 'UTC') - interval '1 day', 'YYYY-MM-DD')
      )
  ) ranked where ranked.place <= 3
  on conflict do nothing;
end $$;
revoke all on function srochnik_private.snapshot_weekly_rewards() from public, anon, authenticated;

create or replace function public.srochnik_session_save(
  p_telegram_id text, p_session_id uuid, p_mode text,
  p_data jsonb default null, p_revision bigint default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, srochnik_private as $$
declare active_session uuid; result jsonb; v_amount bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_telegram_id, 0));
  if exists (select 1 from srochnik_private.bans where telegram_id = p_telegram_id) then
    return jsonb_build_object('banned', true);
  end if;
  if p_mode = 'login' then
    insert into srochnik_private.sessions (telegram_id, session_id)
    values (p_telegram_id, p_session_id)
    on conflict (telegram_id) do update set session_id = excluded.session_id, updated_at = now();

    -- Lock and update the save and award records in the same transaction.
    perform 1 from srochnik_private.saves where telegram_id = p_telegram_id for update;
    if found then
      select coalesce(sum(amount), 0) into v_amount from srochnik_private.weekly_rewards
        where telegram_id = p_telegram_id and claimed_at is null;
      if v_amount > 0 then
        update srochnik_private.saves set
          data = jsonb_set(data, '{money}', to_jsonb(
            (case when data->>'money' ~ '^[0-9]{1,12}$' then (data->>'money')::bigint else 0 end) + v_amount)),
          revision = revision + 1, updated_at = now()
        where telegram_id = p_telegram_id;
        update srochnik_private.weekly_rewards set claimed_at = now()
          where telegram_id = p_telegram_id and claimed_at is null;
      end if;
    end if;
    result := public.srochnik_save(p_telegram_id, 'load', null, null);
    return result || jsonb_build_object('is_admin', exists (select 1 from srochnik_private.admins where telegram_id = p_telegram_id), 'weekly_reward', coalesce(v_amount, 0));
  end if;
  select session_id into active_session from srochnik_private.sessions where telegram_id = p_telegram_id for update;
  if active_session is distinct from p_session_id then return jsonb_build_object('session_expired', true); end if;
  if p_mode not in ('load', 'save') then raise exception 'invalid request'; end if;
  return public.srochnik_save(p_telegram_id, p_mode, p_data, p_revision);
end $$;
revoke all on function public.srochnik_session_save(text, uuid, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.srochnik_session_save(text, uuid, text, jsonb, bigint) to service_role;

do $$
declare job record;
begin
  for job in select jobid from cron.job where jobname = 'srochnik-weekly-rewards' loop
    perform cron.unschedule(job.jobid);
  end loop;
  perform cron.schedule('srochnik-weekly-rewards', '0 0 * * 1', 'select srochnik_private.snapshot_weekly_rewards()');
end $$;
notify pgrst, 'reload schema';
commit;
