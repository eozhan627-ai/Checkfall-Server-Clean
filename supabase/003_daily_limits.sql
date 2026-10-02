-- POVCheck - daily analysis allowance
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Safe to run more than once. Run 001 and 002 first.
--
-- What it does:
--   Players without VIP get one free game analysis a day and can unlock
--   more by watching an ad. This table counts both per player and day.
--
-- Until this script has run, the server counts in memory instead - that
-- works, but the counters are lost whenever the server restarts.

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

    execute format(
        'create table if not exists public.analysis_usage (
            user_id    %s   not null references public.profiles(id) on delete cascade,
            usage_date date not null,
            free_count integer not null default 0,
            ad_count   integer not null default 0,
            primary key (user_id, usage_date)
        )',
        user_id_type
    );
end
$$;

-- Only the game server (service role) reads and writes this table.
alter table public.analysis_usage enable row level security;

commit;

notify pgrst, 'reload schema';
