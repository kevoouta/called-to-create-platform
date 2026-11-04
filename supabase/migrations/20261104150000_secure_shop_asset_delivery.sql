alter table public.products
  add column if not exists storage_path text;

insert into storage.buckets (id, name, public)
values ('shop-deliverables', 'shop-deliverables', false)
on conflict (id) do update
set public = false;

drop policy if exists "Restrict shop deliverables to signed downloads"
  on storage.objects;

create policy "Restrict shop deliverables to signed downloads"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'shop-deliverables')
  with check (bucket_id <> 'shop-deliverables');
