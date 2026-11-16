create table if not exists public.beta_tester_signups (
  id bigint generated always as identity primary key,
  full_name text not null check (length(btrim(full_name)) between 1 and 200),
  email text not null check (length(btrim(email)) between 3 and 320),
  discipline text check (discipline is null or length(discipline) <= 120),
  goals text check (goals is null or length(goals) <= 2000),
  created_at timestamptz not null default now()
);

create unique index if not exists beta_tester_signups_email_idx
  on public.beta_tester_signups (lower(btrim(email)));

alter table public.beta_tester_signups enable row level security;
revoke all on public.beta_tester_signups from public, anon, authenticated;
grant insert (full_name, email, discipline, goals)
  on public.beta_tester_signups to anon, authenticated;
revoke all on sequence public.beta_tester_signups_id_seq from public, anon, authenticated;
grant usage on sequence public.beta_tester_signups_id_seq to anon, authenticated;

drop policy if exists "Allow beta tester signup submissions"
  on public.beta_tester_signups;

create policy "Allow beta tester signup submissions"
  on public.beta_tester_signups
  for insert
  to anon, authenticated
  with check (true);
