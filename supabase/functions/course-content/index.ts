interface CourseContentRequest {
  action: 'preview_video' | 'list_content' | 'lesson_video' | 'download_asset';
  courseId?: string;
  lessonIndex?: number;
  assetIndex?: number;
}

class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const bunnyLibraryId = Deno.env.get('BUNNY_STREAM_LIBRARY_ID');
const bunnyTokenAuthKey = Deno.env.get('BUNNY_STREAM_TOKEN_AUTH_KEY');
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const COURSE_ASSET_BUCKET = 'course-deliverables';
const SIGNED_URL_TTL_SECONDS = 300;
const VIDEO_TOKEN_TTL_SECONDS = 300;

function getSupabaseUrl() {
  if (!supabaseUrl) throw new Error('Missing required function secret: SUPABASE_URL');
  return supabaseUrl.replace(/\/+$/, '');
}

function getServiceRoleKey() {
  if (!supabaseServiceRoleKey) {
    throw new Error('Missing required function secret: SUPABASE_SERVICE_ROLE_KEY');
  }
  return supabaseServiceRoleKey;
}

function response(
  body: unknown,
  status: number,
  origin: string | null,
) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  });
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function adminRequest(path: string, init?: RequestInit) {
  const serviceRoleKey = getServiceRoleKey();
  const result = await fetch(`${getSupabaseUrl()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const text = await result.text();
  if (!result.ok) {
    throw new Error(`Supabase request failed (${result.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getAuthenticatedUser(request: Request) {
  const token = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError('Authentication required.', 401);
  if (!supabaseAnonKey) {
    throw new Error('Missing required function secret: SUPABASE_ANON_KEY');
  }

  const result = await fetch(`${getSupabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!result.ok) throw new HttpError('Authentication required.', 401);
  const user = await result.json();
  if (typeof user.id !== 'string') throw new HttpError('Authentication required.', 401);
  return user as { id: string };
}

function validateCourseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpError('Invalid course.', 400);
  }
  return value;
}

function validateIndex(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10000) {
    throw new HttpError(`Invalid ${label}.`, 400);
  }
  return value;
}

async function requireEnrollment(userId: string, courseId: string) {
  const query = new URLSearchParams({
    select: 'course_id',
    user_id: `eq.${userId}`,
    course_id: `eq.${courseId}`,
    limit: '1',
  });
  const enrollments = await adminRequest(`enrollments?${query}`);
  if (!Array.isArray(enrollments) || enrollments.length === 0) {
    throw new HttpError('An active enrollment is required to access this course.', 403);
  }
}

async function getCourseContent(courseId: string) {
  const query = new URLSearchParams({
    select: 'curriculum,assets',
    course_id: `eq.${courseId}`,
    limit: '1',
  });
  const rows = await adminRequest(`course_private_content?${query}`);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new HttpError('Course materials were not found.', 404);
  }
  return rows[0] as { curriculum?: unknown; assets?: unknown };
}

function getArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    ))
    : [];
}

function getPrivateStoragePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const path = value.trim();
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) return null;
  return path;
}

function getBunnyVideoId(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError('This lesson video is not available yet.', 404);
  }
  if (!bunnyLibraryId || !/^[A-Za-z0-9_-]{1,128}$/.test(bunnyLibraryId)) {
    throw new Error('Missing or invalid function secret: BUNNY_STREAM_LIBRARY_ID');
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError('This lesson video is not configured correctly.', 500);
  }
  const path = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    !['iframe.mediadelivery.net', 'player.mediadelivery.net'].includes(url.hostname) ||
    path.length !== 3 ||
    path[0] !== 'embed' ||
    path[1] !== bunnyLibraryId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(path[2])
  ) {
    throw new HttpError('This lesson video is not configured correctly.', 500);
  }
  return path[2];
}

async function signVideo(videoId: string) {
  if (!bunnyTokenAuthKey) {
    throw new Error('Missing required function secret: BUNNY_STREAM_TOKEN_AUTH_KEY');
  }
  const expires = Math.floor(Date.now() / 1000) + VIDEO_TOKEN_TTL_SECONDS;
  const input = new TextEncoder().encode(`${bunnyTokenAuthKey}${videoId}${expires}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const token = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const query = new URLSearchParams({ token, expires: String(expires) });
  return `https://player.mediadelivery.net/embed/${bunnyLibraryId}/${videoId}?${query}`;
}

async function getPublicCoursePreview(courseId: string) {
  const query = new URLSearchParams({
    select: 'preview_video_url',
    id: `eq.${courseId}`,
    is_published: 'eq.true',
    limit: '1',
  });
  const courses = await adminRequest(`courses?${query}`);
  if (!Array.isArray(courses) || courses.length === 0) {
    throw new HttpError('Course preview was not found.', 404);
  }
  return courses[0].preview_video_url;
}

async function createAssetDownloadUrl(storagePath: string) {
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  const serviceRoleKey = getServiceRoleKey();
  const result = await fetch(
    `${getSupabaseUrl()}/storage/v1/object/sign/${COURSE_ASSET_BUCKET}/${encodedPath}`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    },
  );
  const text = await result.text();
  if (!result.ok) {
    throw new Error(`Could not create course download link (${result.status}): ${text}`);
  }
  const payload = JSON.parse(text) as { signedURL?: unknown; signedUrl?: unknown };
  const signedUrl = payload.signedURL ?? payload.signedUrl;
  const expectedPrefix = `/object/sign/${COURSE_ASSET_BUCKET}/`;
  if (typeof signedUrl !== 'string' || !signedUrl.startsWith(expectedPrefix)) {
    throw new Error('Storage did not return a signed course download link.');
  }
  const url = new URL(`${getSupabaseUrl()}/storage/v1${signedUrl}`);
  return url.toString();
}

async function handleRequest(request: Request) {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    if (origin && !allowedOrigins.includes(origin)) {
      return response({ error: 'Origin not allowed.' }, 403, null);
    }
    const result = new Response(null, { status: 204 });
    result.headers.set('Vary', 'Origin');
    result.headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    result.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (origin) result.headers.set('Access-Control-Allow-Origin', origin);
    return result;
  }
  if (request.method !== 'POST') {
    return response({ error: 'Method not allowed.' }, 405, origin);
  }
  if (origin && !allowedOrigins.includes(origin)) {
    return response({ error: 'Origin not allowed.' }, 403, null);
  }

  try {
    let body: CourseContentRequest;
    try {
      const payload: unknown = await request.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new HttpError('Invalid request body.', 400);
      }
      body = payload as CourseContentRequest;
    } catch {
      throw new HttpError('Invalid request body.', 400);
    }
    const courseId = validateCourseId(body.courseId);
    if (body.action === 'preview_video') {
      const videoId = getBunnyVideoId(await getPublicCoursePreview(courseId));
      return response({ videoUrl: await signVideo(videoId) }, 200, origin);
    }

    const user = await getAuthenticatedUser(request);
    await requireEnrollment(user.id, courseId);
    const courseContent = await getCourseContent(courseId);

    switch (body.action) {
      case 'list_content': {
        const curriculum = getArray(courseContent.curriculum);
        const assets = getArray(courseContent.assets);
        return response({
          lessons: curriculum.map((lesson, index) => ({
            id: lesson.id ?? index + 1,
            title: typeof lesson.title === 'string' ? lesson.title : `Lesson ${index + 1}`,
            duration: typeof lesson.duration === 'string' ? lesson.duration : '',
          })),
          assets: assets.map((asset, index) => ({
            index,
            name: typeof asset.name === 'string' ? asset.name : 'Course resource',
            size: typeof asset.size === 'string' ? asset.size : '',
            available: Boolean(getPrivateStoragePath(asset.storage_path)),
          })),
        }, 200, origin);
      }
      case 'lesson_video': {
        const lessonIndex = validateIndex(body.lessonIndex, 'lesson');
        const lessons = getArray(courseContent.curriculum);
        const lesson = lessons[lessonIndex];
        if (!lesson) throw new HttpError('Lesson not found.', 404);
        const videoId = getBunnyVideoId(lesson.video_url ?? lesson.videoUrl);
        return response({ videoUrl: await signVideo(videoId) }, 200, origin);
      }
      case 'download_asset': {
        const assetIndex = validateIndex(body.assetIndex, 'asset');
        const assets = getArray(courseContent.assets);
        const asset = assets[assetIndex];
        if (!asset) throw new HttpError('Course resource not found.', 404);
        const storagePath = getPrivateStoragePath(asset.storage_path);
        if (!storagePath) {
          throw new HttpError('This resource has not been moved to private course storage yet.', 404);
        }
        const downloadUrl = new URL(await createAssetDownloadUrl(storagePath));
        const fileName = typeof asset.name === 'string' ? asset.name : 'course-resource';
        downloadUrl.searchParams.set('download', fileName);
        return response({
          url: downloadUrl.toString(),
          expiresIn: SIGNED_URL_TTL_SECONDS,
        }, 200, origin);
      }
      default:
        throw new HttpError('Unsupported action.', 400);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return response({ error: error.message }, error.status, origin);
    }
    console.error('Course content request failed:', error);
    return response({ error: 'Could not load course materials. Please try again.' }, 500, origin);
  }
}

Deno.serve(handleRequest);
