-- POVCheck - database hardening
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Safe to run more than once.
--
-- What it does:
--   1. Removes the test function that let any signed-in user give themselves VIP.
--   2. Makes sure the statistics / progress columns exist on "profiles".
--   3. Stops the app (anon / authenticated keys) from changing rating, VIP tier,
--      games played and wins. Only the game server (service role) can change
--      them from now on. Attempts from the app are silently ignored, so older
--      app versions keep working - their values are just no longer accepted.

begin;

-- ---------------------------------------------------------------------------
-- 1. Remove the VIP test function (every overload, whatever its signature)
-- ---------------------------------------------------------------------------
do $$
declare
    fn record;
begin
    for fn in
        select p.oid::regprocedure as signature
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'dev_set_own_vip_tier'
    loop
        execute 'drop function ' || fn.signature;
    end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Columns used by the server and the app
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists games_played   integer not null default 0;
alter table public.profiles add column if not exists wins           integer not null default 0;
alter table public.profiles add column if not exists puzzles_solved integer not null default 0;

-- XP, streak, solved puzzles and lesson stars, so they survive a new phone.
alter table public.profiles add column if not exists progress jsonb;

-- ---------------------------------------------------------------------------
-- 3. Protect server-owned columns
-- ---------------------------------------------------------------------------
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
as $$
declare
    -- auth.role() is 'anon' / 'authenticated' for requests from the app,
    -- 'service_role' for the game server and NULL in the SQL editor.
    caller text := coalesce(auth.role(), 'service_role');
begin
    if caller not in ('anon', 'authenticated') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.rating       := 1000;
        new.games_played := 0;
        new.wins         := 0;

        if new.vip_tier is not null and new.vip_tier::text <> 'none' then
            raise exception 'vip_tier cannot be set by the client';
        end if;

        return new;
    end if;

    -- UPDATE: keep whatever the server stored.
    new.rating       := old.rating;
    new.vip_tier     := old.vip_tier;
    new.games_played := old.games_played;
    new.wins         := old.wins;

    return new;
end
$$;

drop trigger if exists protect_profile_columns on public.profiles;

create trigger protect_profile_columns
    before insert or update on public.profiles
    for each row
    execute function public.protect_profile_columns();

commit;

-- ---------------------------------------------------------------------------
-- Check afterwards (optional): lists the row-level-security rules of the
-- tables the app talks to directly. Each of them should have RLS enabled and
-- only allow a user to write their OWN rows (e.g. games.user_id = auth.uid()).
-- ---------------------------------------------------------------------------
-- select tablename, policyname, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('profiles', 'games', 'friendships')
-- order by tablename, cmd;
--
-- select relname, relrowsecurity
-- from pg_class
-- where relnamespace = 'public'::regnamespace
--   and relname in ('profiles', 'games', 'friendships');
