interface AdminRequest {
  action:
    | 'session_check'
    | 'overview'
    | 'content_list'
    | 'audit_list'
    | 'audit_detail'
    | 'save_course'
    | 'save_product';
  entityId?: string;
  auditId?: number;
  fields?: unknown;
  privateContent?: unknown;
}

type JsonRecord = Record<string, unknown>;

const COURSE_FIELDS = [
  'title',
  'slug',
  'category',
  'description',
  'duration',
  'instructor',
  'preview_video_url',
  'price_kes',
  'price_usd',
  'is_published',
  'is_featured',
  'module_count',
  'card_highlight',
  'image_url',
  'display_order',
] as const;

const PRODUCT_FIELDS = [
  'title',
  'description',
  'category',
  'image_url',
  'price',
  'storage_path',
] as const;

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
const adminUserIds = new Set(
  (Deno.env.get('ADMIN_USER_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

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

function jsonResponse(body: unknown, status: number, origin: string | null) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  });
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function getAuthenticatedUser(request: Request) {
  const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) throw new HttpError('Sign in to continue.', 401);
  if (!supabaseAnonKey) {
    throw new Error('Missing required function secret: SUPABASE_ANON_KEY');
  }

  const result = await fetch(`${getSupabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!result.ok) throw new HttpError('Your session is invalid or expired. Sign in again.', 401);
  const user = await result.json();
  if (typeof user.id !== 'string') throw new HttpError('Your session is invalid. Sign in again.', 401);
  const tokenParts = accessToken.split('.');
  if (tokenParts.length !== 3) {
    throw new HttpError('Your session is invalid. Sign in again.', 401);
  }
  let claims: JsonRecord;
  try {
    const encodedPayload = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = atob(encodedPayload.padEnd(Math.ceil(encodedPayload.length / 4) * 4, '='));
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid JWT payload.');
    }
    claims = parsed as JsonRecord;
  } catch {
    throw new HttpError('Your session is invalid. Sign in again.', 401);
  }
  if (claims.sub !== user.id) {
    throw new HttpError('Your session is invalid. Sign in again.', 401);
  }
  return { id: user.id, assuranceLevel: claims.aal };
}

async function adminRequest(path: string, init?: RequestInit) {
  const serviceRoleKey = getServiceRoleKey();
  return fetch(`${getSupabaseUrl()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...init?.headers,
    },
  });
}

async function adminJsonRequest(path: string, init?: RequestInit) {
  const result = await adminRequest(path, {
    ...init,
    headers: {
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

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(`${label} must be an object.`, 400);
  }
  return value as JsonRecord;
}

function validateAllowedFields(
  value: unknown,
  allowedFields: readonly string[],
  label: string,
) {
  const record = requireRecord(value, label);
  const unknownFields = Object.keys(record).filter((key) => !allowedFields.includes(key));
  if (unknownFields.length > 0) {
    throw new HttpError(`${label} contains unsupported fields.`, 400);
  }
  return record;
}

function validateText(
  record: JsonRecord,
  key: string,
  label: string,
  maxLength: number,
  required = false,
) {
  const value = record[key];
  if (typeof value !== 'string' || value.length > maxLength || (required && !value.trim())) {
    throw new HttpError(`${label} is invalid.`, 400);
  }
  return value.trim();
}

function validateOptionalNumber(
  record: JsonRecord,
  key: string,
  label: string,
  integer = false,
) {
  const value = record[key];
  if (value === null || value === '') return '';
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  ) {
    throw new HttpError(`${label} must be a non-negative ${integer ? 'integer' : 'number'}.`, 400);
  }
  return String(value);
}

function validateImageUrl(record: JsonRecord, key: string, label: string) {
  const value = validateText(record, key, label, 2048);
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(`${label} must be an absolute HTTPS URL.`, 400);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new HttpError(`${label} must be an absolute HTTPS URL.`, 400);
  }
  return url.toString();
}

function validateBunnyEmbedUrl(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new HttpError(`${label} is invalid.`, 400);
  }
  const rawUrl = value.trim();
  if (!rawUrl) return '';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(`${label} must be a Bunny Stream embed URL.`, 400);
  }
  const path = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    !['iframe.mediadelivery.net', 'player.mediadelivery.net'].includes(url.hostname) ||
    path.length !== 3 ||
    path[0] !== 'embed' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(path[1]) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(path[2])
  ) {
    throw new HttpError(`${label} must be a Bunny Stream embed URL.`, 400);
  }
  return `https://iframe.mediadelivery.net/embed/${path[1]}/${path[2]}`;
}

function validateCourseFields(value: unknown) {
  const fields = validateAllowedFields(value, COURSE_FIELDS, 'Course');
  const title = validateText(fields, 'title', 'Course title', 160, true);
  const slug = validateText(fields, 'slug', 'Course slug', 128, true);
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) {
    throw new HttpError('Course slug may only contain letters, numbers, underscores, and hyphens.', 400);
  }
  if (typeof fields.is_published !== 'boolean' || typeof fields.is_featured !== 'boolean') {
    throw new HttpError('Course publication and featured values must be boolean.', 400);
  }
  const priceKes = validateOptionalNumber(fields, 'price_kes', 'KES price');
  if (!priceKes || Number(priceKes) <= 0) {
    throw new HttpError('Course KES price must be greater than zero.', 400);
  }

  return {
    title,
    slug,
    category: validateText(fields, 'category', 'Course category', 100),
    description: validateText(fields, 'description', 'Course description', 10000),
    duration: validateText(fields, 'duration', 'Course duration', 100),
    instructor: validateText(fields, 'instructor', 'Course instructor', 160),
    preview_video_url: validateBunnyEmbedUrl(fields.preview_video_url, 'Course preview URL'),
    price_kes: priceKes,
    price_usd: validateOptionalNumber(fields, 'price_usd', 'USD price'),
    is_published: fields.is_published,
    is_featured: fields.is_featured,
    module_count: validateOptionalNumber(fields, 'module_count', 'Module count', true),
    card_highlight: validateText(fields, 'card_highlight', 'Course highlight', 200),
    image_url: validateImageUrl(fields, 'image_url', 'Course image URL'),
    display_order: validateOptionalNumber(fields, 'display_order', 'Display order', true),
  };
}

function validatePrivateContent(value: unknown) {
  const content = requireRecord(value, 'Private course content');
  if (Object.keys(content).some((key) => key !== 'curriculum' && key !== 'assets')) {
    throw new HttpError('Private course content contains unsupported fields.', 400);
  }
  if (!Array.isArray(content.curriculum) || content.curriculum.length > 500) {
    throw new HttpError('Course curriculum must be an array of at most 500 lessons.', 400);
  }
  if (!Array.isArray(content.assets) || content.assets.length > 500) {
    throw new HttpError('Course assets must be an array of at most 500 entries.', 400);
  }

  const curriculum = content.curriculum.map((value, index) => {
    const lesson = requireRecord(value, `Lesson ${index + 1}`);
    const allowed = ['id', 'title', 'duration', 'video_url', 'videoUrl'];
    if (Object.keys(lesson).some((key) => !allowed.includes(key))) {
      throw new HttpError(`Lesson ${index + 1} contains unsupported fields.`, 400);
    }
    if (
      lesson.id !== undefined &&
      typeof lesson.id !== 'string' &&
      (typeof lesson.id !== 'number' || !Number.isFinite(lesson.id))
    ) {
      throw new HttpError(`Lesson ${index + 1} has an invalid ID.`, 400);
    }
    const title = validateText(lesson, 'title', `Lesson ${index + 1} title`, 240, true);
    const duration = validateText(lesson, 'duration', `Lesson ${index + 1} duration`, 100);
    const rawVideoUrl = lesson.video_url ?? lesson.videoUrl ?? '';
    const normalizedVideoUrl = validateBunnyEmbedUrl(rawVideoUrl, `Lesson ${index + 1} video URL`);
    return {
      ...(lesson.id === undefined ? {} : { id: lesson.id }),
      title,
      duration,
      video_url: normalizedVideoUrl,
    };
  });

  const assets = content.assets.map((value, index) => {
    const asset = requireRecord(value, `Course asset ${index + 1}`);
    if (Object.keys(asset).some((key) => !['name', 'size', 'storage_path'].includes(key))) {
      throw new HttpError(
        `Course asset ${index + 1} has unsupported fields. Use private storage paths instead of public links.`,
        400,
      );
    }
    const name = validateText(asset, 'name', `Course asset ${index + 1} name`, 240, true);
    const size = validateText(asset, 'size', `Course asset ${index + 1} size`, 100);
    const storagePath = validateText(asset, 'storage_path', `Course asset ${index + 1} storage path`, 1024);
    if (
      storagePath &&
      (
        storagePath.startsWith('/') ||
        storagePath.includes('\\') ||
        storagePath.split('/').some((part) => !part || part === '.' || part === '..')
      )
    ) {
      throw new HttpError(`Course asset ${index + 1} storage path is invalid.`, 400);
    }
    return { name, size, storage_path: storagePath };
  });

  return { curriculum, assets };
}

function validateProductFields(value: unknown) {
  const fields = validateAllowedFields(value, PRODUCT_FIELDS, 'Product');
  const price = validateOptionalNumber(fields, 'price', 'Product price');
  if (!price || Number(price) <= 0) {
    throw new HttpError('Product price must be greater than zero.', 400);
  }
  const storagePath = validateText(fields, 'storage_path', 'Product storage path', 1024);
  if (
    storagePath &&
    (
      storagePath.startsWith('/') ||
      storagePath.includes('\\') ||
      storagePath.split('/').some((part) => !part || part === '.' || part === '..')
    )
  ) {
    throw new HttpError('Product storage path is invalid.', 400);
  }
  return {
    title: validateText(fields, 'title', 'Product title', 160, true),
    description: validateText(fields, 'description', 'Product description', 10000),
    category: validateText(fields, 'category', 'Product category', 100),
    image_url: validateImageUrl(fields, 'image_url', 'Product image URL'),
    price,
    storage_path: storagePath,
  };
}

function validateEntityId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpError('Invalid content ID.', 400);
  }
  return value;
}

async function getContentList() {
  const [courses, privateContent, products] = await Promise.all([
    adminJsonRequest(
      'courses?select=id,slug,title,category,description,duration,instructor,price_kes,price_usd,is_published,is_featured,module_count,card_highlight,image_url,display_order&order=display_order.asc.nullslast,title.asc',
    ),
    adminJsonRequest('course_private_content?select=course_id,curriculum,assets'),
    adminJsonRequest(
      'products?select=id,title,description,category,image_url,price,storage_path,created_at&order=created_at.desc',
    ),
  ]);
  if (!Array.isArray(courses) || !Array.isArray(privateContent) || !Array.isArray(products)) {
    throw new Error('Supabase returned an invalid content list.');
  }
  const privateContentById = new Map(
    privateContent.map((item) => [String(item.course_id), item]),
  );
  return {
    courses: courses.map((course) => ({
      ...course,
      private_content: privateContentById.get(String(course.id)) ?? { curriculum: [], assets: [] },
    })),
    products,
  };
}

async function getAuditLog() {
  const result = await adminJsonRequest(
    'admin_content_audit?select=id,actor_id,entity_type,entity_id,created_at&order=created_at.desc&limit=50',
  );
  if (!Array.isArray(result)) throw new Error('Supabase returned an invalid audit log.');
  return result;
}

async function getAuditDetail(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError('Invalid audit entry.', 400);
  }
  const query = new URLSearchParams({
    select: 'id,before_data,after_data',
    id: `eq.${value}`,
    limit: '1',
  });
  const result = await adminJsonRequest(`admin_content_audit?${query}`);
  if (!Array.isArray(result) || !result[0]) {
    throw new HttpError('Audit entry not found.', 404);
  }
  return result[0];
}

async function saveCourse(userId: string, body: AdminRequest) {
  const courseId = validateEntityId(body.entityId);
  const fields = validateCourseFields(body.fields);
  const privateContent = validatePrivateContent(body.privateContent);
  await adminJsonRequest('rpc/admin_save_course', {
    method: 'POST',
    body: JSON.stringify({
      p_actor_id: userId,
      p_course_id: courseId,
      p_fields: fields,
      p_private_content: privateContent,
    }),
  });
  return { saved: true, entityId: courseId };
}

async function saveProduct(userId: string, body: AdminRequest) {
  const productId = validateEntityId(body.entityId);
  const fields = validateProductFields(body.fields);
  await adminJsonRequest('rpc/admin_save_product', {
    method: 'POST',
    body: JSON.stringify({
      p_actor_id: userId,
      p_product_id: productId,
      p_fields: fields,
    }),
  });
  return { saved: true, entityId: productId };
}

async function getExactCount(
  table: string,
  filters: Record<string, string> = {},
  countColumn = 'id',
) {
  const query = new URLSearchParams({ select: countColumn, ...filters });
  const startedAt = performance.now();
  const result = await adminRequest(`${table}?${query}`, {
    method: 'HEAD',
    headers: {
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const durationMs = Math.round(performance.now() - startedAt);
  if (!result.ok) {
    throw new Error(`Could not read ${table} metrics (${result.status}).`);
  }
  const contentRange = result.headers.get('Content-Range') ?? '';
  const total = contentRange.match(/\/(\d+)$/)?.[1];
  if (total === undefined) {
    throw new Error(`Supabase did not return an exact count for ${table}.`);
  }
  return { count: Number(total), durationMs };
}

async function getRecentOrders() {
  const query = new URLSearchParams({
    select: 'reference,item_type,amount_minor,currency,status,created_at',
    order: 'created_at.desc',
    limit: '10',
  });
  const startedAt = performance.now();
  const result = await adminRequest(`payment_orders?${query}`);
  const durationMs = Math.round(performance.now() - startedAt);
  if (!result.ok) {
    throw new Error(`Could not load recent payment orders (${result.status}).`);
  }
  const orders: unknown = await result.json();
  if (!Array.isArray(orders)) {
    throw new Error('Supabase returned an invalid payment order list.');
  }
  return { orders, durationMs };
}

async function getOverview() {
  const [
    courses,
    products,
    enrollments,
    orders,
    paidOrders,
    pendingOrders,
    failedOrders,
    recentOrders,
  ] = await Promise.all([
    getExactCount('courses'),
    getExactCount('products'),
    getExactCount('enrollments', {}, 'course_id'),
    getExactCount('payment_orders'),
    getExactCount('payment_orders', { status: 'eq.paid' }),
    getExactCount('payment_orders', { status: 'eq.pending' }),
    getExactCount('payment_orders', { status: 'eq.failed' }),
    getRecentOrders(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      courses: courses.count,
      products: products.count,
      enrollments: enrollments.count,
      orders: orders.count,
      paidOrders: paidOrders.count,
      pendingOrders: pendingOrders.count,
      failedOrders: failedOrders.count,
    },
    recentOrders: recentOrders.orders,
    diagnostics: {
      database: 'available',
      databaseQueryMs: {
        courses: courses.durationMs,
        products: products.durationMs,
        enrollments: enrollments.durationMs,
        orders: orders.durationMs,
        paidOrders: paidOrders.durationMs,
        pendingOrders: pendingOrders.durationMs,
        failedOrders: failedOrders.durationMs,
        recentOrders: recentOrders.durationMs,
      },
    },
  };
}

async function handleRequest(request: Request) {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    if (origin && !allowedOrigins.includes(origin)) {
      return jsonResponse({ error: 'Origin not allowed.' }, 403, null);
    }
    const response = new Response(null, { status: 204 });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Vary', 'Origin');
    response.headers.set(
      'Access-Control-Allow-Headers',
      'authorization, x-client-info, apikey, content-type',
    );
    response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
    return response;
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, origin);
  }
  if (origin && !allowedOrigins.includes(origin)) {
    return jsonResponse({ error: 'Origin not allowed.' }, 403, null);
  }

  try {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new HttpError('Invalid request body.', 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HttpError('Invalid request body.', 400);
    }
    const body = payload as AdminRequest;
    if (
      ![
        'session_check',
        'overview',
        'content_list',
        'audit_list',
        'audit_detail',
        'save_course',
        'save_product',
      ].includes(body.action)
    ) {
      throw new HttpError('Unsupported dashboard action.', 400);
    }
    const user = await getAuthenticatedUser(request);
    if (adminUserIds.size === 0) {
      throw new Error('No administrator IDs are configured in ADMIN_USER_IDS.');
    }
    if (body.action === 'session_check') {
      return jsonResponse({ authorized: adminUserIds.has(user.id) }, 200, origin);
    }
    if (!adminUserIds.has(user.id)) {
      throw new HttpError('Administrator access is required.', 403);
    }
    if (user.assuranceLevel !== 'aal2') {
      throw new HttpError('Complete multi-factor authentication to continue.', 403);
    }

    const result = body.action === 'overview'
      ? await getOverview()
      : body.action === 'content_list'
      ? await getContentList()
      : body.action === 'audit_list'
      ? await getAuditLog()
      : body.action === 'audit_detail'
      ? await getAuditDetail(body.auditId)
      : body.action === 'save_course'
      ? await saveCourse(user.id, body)
      : await saveProduct(user.id, body);
    return jsonResponse(result, 200, origin);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ error: error.message }, error.status, origin);
    }
    console.error('Admin dashboard request failed:', error);
    return jsonResponse(
      { error: 'Could not load dashboard data. Please try again later.' },
      500,
      origin,
    );
  }
}

Deno.serve(handleRequest);
