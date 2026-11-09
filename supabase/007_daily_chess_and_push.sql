-- POVCheck - Daily Chess (correspondence games) and push notifications
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Safe to run more than once. Run 001 first.
--
-- What it does:
--   1. daily_games   games with days per move instead of a clock
--   2. push_tokens   the phones that get push notifications, with the
--                    player's choices (which notifications they want)
--
-- Only the game server (service role) reads and writes these tables.
-- Until this script has run, Daily Chess shows "not available" in the app
-- and no push notifications are sent.

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

    -- 1. Daily Chess. status: open (waiting for an opponent), active,
    --    finished, cancelled. A deleted account removes its games.
    execute format(
        'create table if not exists public.daily_games (
            id            uuid primary key default gen_random_uuid(),
            creator_id    %1$s not null references public.profiles(id) on delete cascade,
            white_id      %1$s references public.profiles(id) on delete cascade,
            black_id      %1$s references public.profiles(id) on delete cascade,
            status        text not null default ''open'',
            days_per_move integer not null default 1,
            pgn           text not null default '''',
            fen           text not null default ''rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'',
            move_count    integer not null default 0,
            result        text,
            end_reason    text,
            last_move_at  timestamptz,
            deadline_at   timestamptz,
            created_at    timestamptz not null default now(),
            updated_at    timestamptz not null default now()
        )',
        user_id_type
    );

    -- 2. Push tokens (Expo push tokens, one row per phone).
    execute format(
        'create table if not exists public.push_tokens (
            token                  text primary key,
            user_id                %1$s not null references public.profiles(id) on delete cascade,
            platform               text not null default '''',
            notify_daily           boolean not null default true,
            notify_searching       boolean not null default true,
            notify_events          boolean not null default true,
            last_search_notify_at  timestamptz,
            created_at             timestamptz not null default now(),
            updated_at             timestamptz not null default now()
        )',
        user_id_type
    );
end
$$;

create index if not exists daily_games_white_idx    on public.daily_games (white_id, status);
create index if not exists daily_games_black_idx    on public.daily_games (black_id, status);
create index if not exists daily_games_open_idx     on public.daily_games (status, created_at) where status = 'open';
create index if not exists daily_games_deadline_idx on public.daily_games (deadline_at) where status = 'active';
create index if not exists push_tokens_user_idx     on public.push_tokens (user_id);

-- Row level security without any policy keeps the app keys out.
alter table public.daily_games enable row level security;
alter table public.push_tokens enable row level security;

commit;

notify pgrst, 'reload schema';
