-- POVCheck - player reports, support requests and error reports
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Safe to run more than once. Run 001 first.
--
-- What it does:
--   1. player_reports     a player reported the opponent of a game (with reason)
--   2. support_requests   messages from the support form of the app
--   3. client_errors      errors the app ran into, sent automatically
--
-- Only the game server (service role) can read and write these tables. You
-- look at them in the dashboard: Table Editor -> pick the table. Set "status"
-- to 'done' when you have dealt with an entry.
--
-- Until this script has run, the app tells the player that the report or
-- message could not be saved.

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

    -- 1. Reports. A deleted account keeps the reports it made or received,
    --    just without the link to the profile.
    execute format(
        'create table if not exists public.player_reports (
            id                uuid primary key default gen_random_uuid(),
            reporter_id       %1$s references public.profiles(id) on delete set null,
            reported_id       %1$s references public.profiles(id) on delete set null,
            reported_name     text not null default '''',
            room_id           text not null,
            reason            text not null,
            details           text not null default '''',
            pgn               text not null default '''',
            computer_opponent boolean not null default false,
            status            text not null default ''open'',
            created_at        timestamptz not null default now(),
            unique (reporter_id, room_id)
        )',
        user_id_type
    );

    -- 2. Support requests (also from people without an account).
    execute format(
        'create table if not exists public.support_requests (
            id          uuid primary key default gen_random_uuid(),
            user_id     %1$s references public.profiles(id) on delete set null,
            category    text not null default ''other'',
            message     text not null,
            contact     text not null default '''',
            platform    text not null default '''',
            app_version text not null default '''',
            status      text not null default ''open'',
            created_at  timestamptz not null default now()
        )',
        user_id_type
    );

    -- 3. Errors of the app.
    execute format(
        'create table if not exists public.client_errors (
            id          uuid primary key default gen_random_uuid(),
            user_id     %1$s references public.profiles(id) on delete set null,
            message     text not null,
            stack       text not null default '''',
            screen      text not null default '''',
            platform    text not null default '''',
            app_version text not null default '''',
            fatal       boolean not null default false,
            created_at  timestamptz not null default now()
        )',
        user_id_type
    );
end
$$;

create index if not exists player_reports_reported_idx on public.player_reports (reported_id, created_at desc);
create index if not exists player_reports_status_idx   on public.player_reports (status, created_at desc);
create index if not exists support_requests_status_idx on public.support_requests (status, created_at desc);
create index if not exists client_errors_created_idx   on public.client_errors (created_at desc);

-- Row level security without any policy keeps the app keys out.
alter table public.player_reports   enable row level security;
alter table public.support_requests enable row level security;
alter table public.client_errors    enable row level security;

commit;

notify pgrst, 'reload schema';
