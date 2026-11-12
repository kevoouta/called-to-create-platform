alter table public.newsletter_subscribers
  add column if not exists first_name text;
