create table if not exists public.admin_content_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  entity_type text not null check (entity_type in ('course', 'product')),
  entity_id text not null,
  before_data jsonb not null,
  after_data jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_content_audit_created_at_idx
  on public.admin_content_audit (created_at desc);

alter table public.admin_content_audit enable row level security;
revoke all on public.admin_content_audit from public, anon, authenticated;
grant all on public.admin_content_audit to service_role;
grant usage, select on sequence public.admin_content_audit_id_seq to service_role;

create or replace function public.admin_save_course(
  p_actor_id uuid,
  p_course_id text,
  p_fields jsonb,
  p_private_content jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_course public.courses%rowtype;
  current_private_content public.course_private_content%rowtype;
  before_data jsonb;
  after_data jsonb;
begin
  if p_actor_id is null
    or jsonb_typeof(p_fields) is distinct from 'object'
    or jsonb_typeof(p_private_content) is distinct from 'object'
    or (p_fields - array[
      'title', 'slug', 'category', 'description', 'duration', 'instructor',
      'preview_video_url', 'price_kes', 'price_usd', 'is_published', 'is_featured', 'module_count',
      'card_highlight', 'image_url', 'display_order'
    ]) <> '{}'::jsonb
    or jsonb_typeof(p_private_content->'curriculum') is distinct from 'array'
    or jsonb_typeof(p_private_content->'assets') is distinct from 'array' then
    raise exception 'Invalid course update';
  end if;

  select *
  into current_course
  from public.courses
  where id::text = p_course_id
  for update;

  if not found then
    raise exception 'Course not found';
  end if;

  select *
  into current_private_content
  from public.course_private_content
  where course_id = p_course_id
  for update;

  if not found then
    raise exception 'Private course content not found';
  end if;

  before_data := jsonb_build_object(
    'course', to_jsonb(current_course),
    'private_content', to_jsonb(current_private_content)
  );

  update public.courses
  set title = p_fields->>'title',
      slug = p_fields->>'slug',
      category = p_fields->>'category',
      description = p_fields->>'description',
      duration = p_fields->>'duration',
      instructor = p_fields->>'instructor',
      preview_video_url = p_fields->>'preview_video_url',
      price_kes = (p_fields->>'price_kes')::numeric,
      price_usd = nullif(p_fields->>'price_usd', '')::numeric,
      is_published = (p_fields->>'is_published')::boolean,
      is_featured = (p_fields->>'is_featured')::boolean,
      module_count = nullif(p_fields->>'module_count', '')::integer,
      card_highlight = p_fields->>'card_highlight',
      image_url = p_fields->>'image_url',
      display_order = nullif(p_fields->>'display_order', '')::integer
  where id::text = p_course_id;

  update public.course_private_content
  set curriculum = p_private_content->'curriculum',
      assets = p_private_content->'assets'
  where course_id = p_course_id;

  select jsonb_build_object(
    'course', to_jsonb(course),
    'private_content', to_jsonb(private_content)
  )
  into after_data
  from public.courses course
  join public.course_private_content private_content
    on private_content.course_id = course.id::text
  where course.id::text = p_course_id;

  insert into public.admin_content_audit (
    actor_id,
    entity_type,
    entity_id,
    before_data,
    after_data
  )
  values (p_actor_id, 'course', p_course_id, before_data, after_data);
end;
$$;

create or replace function public.admin_save_product(
  p_actor_id uuid,
  p_product_id text,
  p_fields jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_product public.products%rowtype;
  before_data jsonb;
  after_data jsonb;
begin
  if p_actor_id is null
    or jsonb_typeof(p_fields) is distinct from 'object'
    or (p_fields - array[
      'title', 'description', 'category', 'image_url', 'price', 'storage_path'
    ]) <> '{}'::jsonb then
    raise exception 'Invalid product update';
  end if;

  select *
  into current_product
  from public.products
  where id::text = p_product_id
  for update;

  if not found then
    raise exception 'Product not found';
  end if;

  before_data := to_jsonb(current_product);

  update public.products
  set title = p_fields->>'title',
      description = p_fields->>'description',
      category = p_fields->>'category',
      image_url = p_fields->>'image_url',
      price = (p_fields->>'price')::numeric,
      storage_path = nullif(p_fields->>'storage_path', '')
  where id::text = p_product_id;

  select to_jsonb(product)
  into after_data
  from public.products product
  where product.id::text = p_product_id;

  insert into public.admin_content_audit (
    actor_id,
    entity_type,
    entity_id,
    before_data,
    after_data
  )
  values (p_actor_id, 'product', p_product_id, before_data, after_data);
end;
$$;

revoke all on function public.admin_save_course(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_save_course(uuid, text, jsonb, jsonb)
  to service_role;

revoke all on function public.admin_save_product(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_save_product(uuid, text, jsonb)
  to service_role;
