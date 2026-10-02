ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS instructor text,
  ADD COLUMN IF NOT EXISTS price_kes numeric(10, 2),
  ADD COLUMN IF NOT EXISTS price_usd numeric(10, 2),
  ADD COLUMN IF NOT EXISTS preview_video_url text,
  ADD COLUMN IF NOT EXISTS curriculum jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS assets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS module_count integer,
  ADD COLUMN IF NOT EXISTS card_highlight text,
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS display_order integer;

ALTER TABLE public.courses
  ALTER COLUMN is_featured DROP DEFAULT;

ALTER TABLE public.courses
  ALTER COLUMN is_featured TYPE boolean
  USING COALESCE(lower(trim(is_featured::text)) IN ('true', 't', '1', 'yes'), false);

ALTER TABLE public.courses
  ALTER COLUMN is_featured SET DEFAULT false,
  ALTER COLUMN is_featured SET NOT NULL;

UPDATE public.courses
SET slug = id::text
WHERE slug IS NULL;

ALTER TABLE public.courses
  ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS courses_slug_unique
ON public.courses (slug);