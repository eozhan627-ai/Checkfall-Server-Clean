-- POVCheck - VIP subscriptions
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.
-- Safe to run more than once.
--
-- What it does:
--   1. Remembers until when a player's VIP subscription is paid
--      (free trial or current month). The game server fills it in.
--   2. Adds the "updated_at" column older server versions write to.

begin;

alter table public.profiles add column if not exists vip_expires_at timestamptz;
alter table public.profiles add column if not exists updated_at     timestamptz default now();

commit;

notify pgrst, 'reload schema';
