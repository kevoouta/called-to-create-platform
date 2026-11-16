alter table public.beta_tester_signups
  add column status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  add column auth_user_id uuid references auth.users (id) on delete set null;

create unique index beta_tester_signups_auth_user_id_idx
  on public.beta_tester_signups (auth_user_id)
  where auth_user_id is not null;

update public.beta_tester_signups signup
set auth_user_id = account.id
from auth.users account
where lower(btrim(signup.email)) = lower(btrim(account.email))
  and account.email_confirmed_at is not null
  and signup.auth_user_id is null;

create or replace function public.link_beta_signup_to_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.email is not null and new.email_confirmed_at is not null then
    update public.beta_tester_signups
    set auth_user_id = new.id
    where lower(btrim(email)) = lower(btrim(new.email))
      and auth_user_id is null;
  end if;
  return new;
end;
$$;

revoke all on function public.link_beta_signup_to_auth_user() from public, anon, authenticated;

drop trigger if exists link_beta_signup_to_auth_user on auth.users;
create trigger link_beta_signup_to_auth_user
  after insert or update on auth.users
  for each row
  execute function public.link_beta_signup_to_auth_user();

create or replace function public.link_beta_tester_signup()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  verified_email text;
begin
  select lower(btrim(account.email))
  into verified_email
  from auth.users account
  where account.id = auth.uid()
    and account.email_confirmed_at is not null;

  if verified_email is null then
    return false;
  end if;

  update public.beta_tester_signups
  set auth_user_id = auth.uid()
  where lower(btrim(email)) = verified_email
    and auth_user_id is null;

  return exists (
    select 1
    from public.beta_tester_signups
    where lower(btrim(email)) = verified_email
      and auth_user_id = auth.uid()
  );
end;
$$;

revoke all on function public.link_beta_tester_signup() from public, anon, authenticated;
grant execute on function public.link_beta_tester_signup() to authenticated;

create or replace function public.has_beta_access()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1
    from public.beta_tester_signups signup
    join auth.users account on account.id = signup.auth_user_id
    where signup.auth_user_id = auth.uid()
      and signup.status = 'approved'
      and account.email_confirmed_at is not null
  );
$$;

revoke all on function public.has_beta_access() from public, anon, authenticated;
grant execute on function public.has_beta_access() to authenticated;

alter table public.courses enable row level security;
revoke all on public.courses from public, anon, authenticated;
grant select on public.courses to authenticated;
drop policy if exists "Approved beta testers can read courses" on public.courses;
create policy "Approved beta testers can read courses"
  on public.courses
  for select
  to authenticated
  using (public.has_beta_access());
drop policy if exists "Require beta approval for course access" on public.courses;
create policy "Require beta approval for course access"
  on public.courses
  as restrictive
  for select
  to authenticated
  using (public.has_beta_access());

alter table public.products enable row level security;
revoke all on public.products from public, anon, authenticated;
grant select on public.products to authenticated;
drop policy if exists "Approved beta testers can read products" on public.products;
create policy "Approved beta testers can read products"
  on public.products
  for select
  to authenticated
  using (public.has_beta_access());
drop policy if exists "Require beta approval for product access" on public.products;
create policy "Require beta approval for product access"
  on public.products
  as restrictive
  for select
  to authenticated
  using (public.has_beta_access());

alter table public.enrollments enable row level security;
revoke all on public.enrollments from public, anon, authenticated;
grant select on public.enrollments to authenticated;
drop policy if exists "Approved beta testers can read their enrollments" on public.enrollments;
create policy "Approved beta testers can read their enrollments"
  on public.enrollments
  for select
  to authenticated
  using (auth.uid() = user_id and public.has_beta_access());
drop policy if exists "Require beta approval for enrollment access" on public.enrollments;
create policy "Require beta approval for enrollment access"
  on public.enrollments
  as restrictive
  for select
  to authenticated
  using (public.has_beta_access());

alter table public.payment_orders enable row level security;
revoke all on public.payment_orders from public, anon, authenticated;
grant select on public.payment_orders to authenticated;
drop policy if exists "Require beta approval for payment access" on public.payment_orders;
create policy "Require beta approval for payment access"
  on public.payment_orders
  as restrictive
  for select
  to authenticated
  using (public.has_beta_access());
