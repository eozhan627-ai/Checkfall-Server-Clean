-- POVCheck - promo codes for free VIP (e.g. the TikTok launch promo)
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Safe to run more than once. Run 001 and 004 first.
--
-- What it does:
--   1. promo_codes            codes that give VIP for some days, each with a
--                             limit of how many players can redeem it
--   2. vip_grants             who redeemed which code, and until when
--   3. profiles.vip_base_tier the plan WITHOUT codes (store subscription, or
--                             set by hand). The game server keeps
--                             profiles.vip_tier at the better of this plan and
--                             the player's running codes - everything else in
--                             the app keeps reading vip_tier as before.
--   4. redeem_promo_code()    redeems a code; only the game server may call it.
--   5. The TikTok launch promo: code TIKTOK100 = Gold VIP for one year, for
--      the first 100 players who redeem it. Change the code text below before
--      you run the script if you want a different one.
--
-- Later, in the dashboard:
--   - how many have redeemed:  Table Editor -> promo_codes (column "uses")
--   - who redeemed:            Table Editor -> vip_grants
--   - stop a code:             promo_codes -> set "active" to false
--   - give one player VIP by hand: set "vip_base_tier" AND "vip_tier" in
--     profiles (vip_base_tier alone is enough when the server sets the plan
--     next time; vip_tier alone is overwritten when that player's code ends)

begin;

do $$
declare
    user_id_type text;
begin
    select format_type(a.atttypid, a.atttypmod) into user_id_type
    from pg_attribute a
    where a.attrelid = 'public.profiles'::regclass and a.attname = 'id' and not a.attisdropped;

    if user_id_type is null then
        raise exception 'Table "profiles" must exist with an "id" column.';
    end if;

    -- 1. Codes. Stored in capital letters; the app may send them in any case.
    create table if not exists public.promo_codes (
        code       text primary key check (code ~ '^[A-Z0-9-]{4,24}$'),
        tier       text not null check (tier in ('silver', 'gold', 'diamond')),
        days       integer not null check (days between 1 and 3650),
        max_uses   integer not null check (max_uses >= 1),
        uses       integer not null default 0,
        active     boolean not null default true,
        starts_at  timestamptz,               -- empty: can be redeemed right away
        ends_at    timestamptz,               -- empty: until all places are taken
        note       text not null default '',
        created_at timestamptz not null default now()
    );

    -- 2. Redemptions. One per player and code. "ended" is set by the game
    --    server once the VIP of this code is over and the plan was updated.
    execute format(
        'create table if not exists public.vip_grants (
            id         bigint generated always as identity primary key,
            user_id    %1$s not null references public.profiles(id) on delete cascade,
            code       text not null references public.promo_codes(code) on update cascade,
            tier       text not null check (tier in (''silver'', ''gold'', ''diamond'')),
            starts_at  timestamptz not null default now(),
            ends_at    timestamptz not null,
            ended      boolean not null default false,
            created_at timestamptz not null default now(),
            unique (user_id, code)
        )',
        user_id_type
    );

    -- 3. The plan without codes. On the first run it starts as the plan
    --    every player has now (subscriptions, plans set by hand).
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles' and column_name = 'vip_base_tier'
    ) then
        alter table public.profiles add column vip_base_tier text not null default 'none';
        update public.profiles set vip_base_tier = coalesce(vip_tier::text, 'none');
    end if;
end
$$;

create index if not exists vip_grants_running_idx on public.vip_grants (ended, ends_at);
create index if not exists vip_grants_user_idx    on public.vip_grants (user_id);

-- The app must not change the plan without codes (same as vip_tier in 001).
-- A trigger of its own, so running 001 again cannot remove this protection.
create or replace function public.protect_vip_base_tier()
returns trigger
language plpgsql
as $$
declare
    caller text := coalesce(auth.role(), 'service_role');
begin
    if caller not in ('anon', 'authenticated') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.vip_base_tier := 'none';
    else
        new.vip_base_tier := old.vip_base_tier;
    end if;

    return new;
end
$$;

drop trigger if exists protect_vip_base_tier on public.profiles;

create trigger protect_vip_base_tier
    before insert or update on public.profiles
    for each row
    execute function public.protect_vip_base_tier();

-- Codes are invisible to the app. A player may see their own redemptions
-- (the VIP page shows until when the code's VIP runs).
alter table public.promo_codes enable row level security;
alter table public.vip_grants  enable row level security;

drop policy if exists vip_grants_read_own on public.vip_grants;

create policy vip_grants_read_own on public.vip_grants
    for select
    using (user_id::text = auth.uid()::text);

-- 4. Redeeming. The row lock on the code makes players who redeem at the
--    same moment wait for each other, so a code is never given out more
--    often than max_uses.
--    Answer: {"status": "ok" | "already" | "used_up" | "expired" |
--             "not_started" | "invalid", ...}; with "ok" also the plan, the
--    end of the VIP and the place (37 = the 37th player with this code).
create or replace function public.redeem_promo_code(p_user_id public.profiles.id%type, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    wanted  text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
    promo   public.promo_codes%rowtype;
    grant_  public.vip_grants%rowtype;
    taken   integer;
begin
    select * into promo from public.promo_codes where code = wanted for update;

    if not found or not promo.active then
        return jsonb_build_object('status', 'invalid');
    end if;

    if promo.starts_at is not null and now() < promo.starts_at then
        return jsonb_build_object('status', 'not_started', 'starts_at', promo.starts_at);
    end if;

    if promo.ends_at is not null and now() >= promo.ends_at then
        return jsonb_build_object('status', 'expired');
    end if;

    select * into grant_ from public.vip_grants where user_id = p_user_id and code = wanted;

    if found then
        return jsonb_build_object('status', 'already', 'tier', grant_.tier, 'ends_at', grant_.ends_at);
    end if;

    -- Counted, not trusted: a redemption deleted by hand frees its place.
    select count(*) into taken from public.vip_grants where code = wanted;

    if taken >= promo.max_uses then
        update public.promo_codes set uses = taken where code = wanted;
        return jsonb_build_object('status', 'used_up', 'max_uses', promo.max_uses);
    end if;

    insert into public.vip_grants (user_id, code, tier, ends_at)
    values (p_user_id, wanted, promo.tier, now() + make_interval(days => promo.days))
    returning * into grant_;

    update public.promo_codes set uses = taken + 1 where code = wanted;

    return jsonb_build_object(
        'status', 'ok',
        'tier', grant_.tier,
        'ends_at', grant_.ends_at,
        'place', taken + 1,
        'max_uses', promo.max_uses
    );
end
$$;

-- Only the game server (service role) may redeem - never the app directly.
do $$
declare
    fn record;
begin
    for fn in
        select p.oid::regprocedure as signature
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'redeem_promo_code'
    loop
        execute 'revoke all on function ' || fn.signature || ' from public, anon, authenticated';
        execute 'grant execute on function ' || fn.signature || ' to service_role';
    end loop;
end
$$;

-- 5. The TikTok launch promo: Gold VIP for 365 days, the first 100 players.
insert into public.promo_codes (code, tier, days, max_uses, note)
values ('TIKTOK100', 'gold', 365, 100, 'TikTok launch: the first 100 get Gold VIP for one year')
on conflict (code) do nothing;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Optional: 100 personal codes instead of one public code (one use each,
-- e.g. to send by DM). Run separately; the last line lists the new codes.
-- ---------------------------------------------------------------------------
-- insert into public.promo_codes (code, tier, days, max_uses, note)
-- select 'TT-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)), 'gold', 365, 1, 'TikTok DM'
-- from generate_series(1, 100)
-- on conflict (code) do nothing;
--
-- select code from public.promo_codes where note = 'TikTok DM' order by created_at;
