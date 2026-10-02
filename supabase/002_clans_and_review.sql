-- POVCheck - clans, presence and game review
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Safe to run more than once. Run 001_secure_profiles.sql first.
--
-- What it does:
--   1. Clans get a join type (open / on request / invite only), a minimum
--      rating and a badge.
--   2. New table for requests to join a clan.
--   3. Profiles remember when a player was last online.
--   4. Games remember which colour the player had and the opponent's name,
--      so the review can show both players correctly.
--
-- Until this script has run, the server keeps working with the old tables:
-- every clan simply counts as "open" and the clan settings cannot be saved.

begin;

-- ---------------------------------------------------------------------------
-- 1. Clan settings
-- ---------------------------------------------------------------------------
alter table public.clans add column if not exists join_type   text    not null default 'open';
alter table public.clans add column if not exists min_rating  integer not null default 0;
alter table public.clans add column if not exists badge       text;
alter table public.clans add column if not exists badge_color text;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'clans_join_type_check' and conrelid = 'public.clans'::regclass
    ) then
        alter table public.clans
            add constraint clans_join_type_check
            check (join_type in ('open', 'request', 'closed'));
    end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Requests to join a clan
-- ---------------------------------------------------------------------------
-- The id columns take over the exact types of clans.id and profiles.id, so the
-- script works whether those are uuid or text.
do $$
declare
    clan_id_type text;
    user_id_type text;
begin
    select format_type(a.atttypid, a.atttypmod) into clan_id_type
    from pg_attribute a
    where a.attrelid = 'public.clans'::regclass and a.attname = 'id' and not a.attisdropped;

    select format_type(a.atttypid, a.atttypmod) into user_id_type
    from pg_attribute a
    where a.attrelid = 'public.profiles'::regclass and a.attname = 'id' and not a.attisdropped;

    if clan_id_type is null or user_id_type is null then
        raise exception 'Tables "clans" and "profiles" must exist with an "id" column.';
    end if;

    execute format(
        'create table if not exists public.clan_join_requests (
            id         uuid primary key default gen_random_uuid(),
            clan_id    %s not null references public.clans(id)    on delete cascade,
            user_id    %s not null references public.profiles(id) on delete cascade,
            status     text not null default ''pending'',
            created_at timestamptz not null default now(),
            unique (clan_id, user_id)
        )',
        clan_id_type,
        user_id_type
    );
end
$$;

create index if not exists clan_join_requests_clan_idx on public.clan_join_requests (clan_id, status);
create index if not exists clan_join_requests_user_idx on public.clan_join_requests (user_id, status);

-- Only the game server (service role) reads and writes this table.
-- Row level security without any policy keeps the app keys out.
alter table public.clan_join_requests enable row level security;

-- ---------------------------------------------------------------------------
-- 3. "Last seen" for the member and friends list
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- 4. Game review
-- ---------------------------------------------------------------------------
alter table public.games add column if not exists player_color  text;
alter table public.games add column if not exists opponent_name text;

commit;

-- Tell the API about the new columns right away (otherwise it can take a
-- minute until they are visible).
notify pgrst, 'reload schema';
