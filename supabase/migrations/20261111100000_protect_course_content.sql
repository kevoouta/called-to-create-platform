alter table public.courses
  add column if not exists curriculum jsonb not null default '[]'::jsonb,
  add column if not exists assets jsonb not null default '[]'::jsonb;

create table if not exists public.course_private_content (
  course_id text primary key,
  curriculum jsonb not null default '[]'::jsonb,
  assets jsonb not null default '[]'::jsonb
);

alter table public.course_private_content enable row level security;
revoke all on public.course_private_content from public, anon, authenticated;
grant all on public.course_private_content to service_role;

insert into public.course_private_content (course_id, curriculum, assets)
select
  course.id::text,
  coalesce(course.curriculum, '[]'::jsonb),
  coalesce(course.assets, '[]'::jsonb)
from public.courses course
on conflict (course_id) do update
set curriculum = excluded.curriculum,
    assets = excluded.assets;

update public.courses course
set curriculum = coalesce(
      (
        select jsonb_agg(
          case
            when jsonb_typeof(lesson.value) = 'object'
              then lesson.value - 'video_url' - 'videoUrl'
            else lesson.value
          end
          order by lesson.ordinality
        )
        from jsonb_array_elements(
          case
            when jsonb_typeof(course.curriculum) = 'array' then course.curriculum
            else '[]'::jsonb
          end
        ) with ordinality as lesson(value, ordinality)
      ),
      '[]'::jsonb
    ),
    assets = '[]'::jsonb;

insert into storage.buckets (id, name, public)
values ('course-deliverables', 'course-deliverables', false)
on conflict (id) do update
set public = false;

drop policy if exists "Restrict course deliverables to signed downloads"
  on storage.objects;

create policy "Restrict course deliverables to signed downloads"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'course-deliverables')
  with check (bucket_id <> 'course-deliverables');
