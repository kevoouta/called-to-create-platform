const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/+$/, '');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const bunnyApiKey = Deno.env.get('BUNNY_STREAM_API_KEY');
const bunnyLibraryId = Deno.env.get('BUNNY_STREAM_LIBRARY_ID');
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

async function getAdminUser(request: Request) {
  const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken || !supabaseUrl || !supabaseAnonKey) {
    throw new Response('Authentication required.', { status: 401 });
  }
  const result = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!result.ok) throw new Response('Your session is invalid or expired.', { status: 401 });
  const user = await result.json();
  const tokenParts = accessToken.split('.');
  if (typeof user.id !== 'string' || tokenParts.length !== 3) {
    throw new Response('Your session is invalid.', { status: 401 });
  }

  let claims: Record<string, unknown>;
  try {
    const encoded = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid JWT payload.');
    }
    claims = parsed as Record<string, unknown>;
  } catch {
    throw new Response('Your session is invalid.', { status: 401 });
  }
  if (claims.sub !== user.id) throw new Response('Your session is invalid.', { status: 401 });
  if (!adminUserIds.has(user.id)) throw new Response('Administrator access is required.', { status: 403 });
  if (claims.aal !== 'aal2') {
    throw new Response('Complete multi-factor authentication to continue.', { status: 403 });
  }
  return { id: user.id };
}

async function recordUploadAudit(userId: string, videoId: string, size: number | null) {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase service configuration is unavailable.');
  }
  const result = await fetch(`${supabaseUrl}/rest/v1/admin_action_audit?select=id`, {
    method: 'POST',
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([{
      actor_id: userId,
      provider: 'bunny',
      action: 'upload_video',
      target_id: videoId,
      status: 'pending',
      details: { size_bytes: size },
    }]),
  });
  if (!result.ok) {
    console.error('Could not create Bunny upload audit entry:', result.status);
    throw new Error('Could not record the upload action before sending the file.');
  }
  const rows = await result.json();
  if (!Array.isArray(rows) || typeof rows[0]?.id !== 'number') {
    throw new Error('Could not record the upload action before sending the file.');
  }
  return rows[0].id as number;
}

async function updateUploadAudit(auditId: number, status: 'succeeded' | 'failed') {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase service configuration is unavailable.');
  }
  const result = await fetch(
    `${supabaseUrl}/rest/v1/admin_action_audit?id=eq.${auditId}`,
    {
      method: 'PATCH',
      headers: {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    },
  );
  if (!result.ok) {
    console.error('Could not update Bunny upload audit entry:', result.status);
    throw new Error('The upload audit status could not be updated.');
  }
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.includes(origin)) {
      return jsonResponse({ error: 'Origin not allowed.' }, 403, null);
    }
    const response = new Response(null, { status: 204 });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set(
      'Access-Control-Allow-Headers',
      'authorization, apikey, content-type, x-video-id',
    );
    response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return response;
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, origin);
  }
  if (!origin || !allowedOrigins.includes(origin)) {
    return jsonResponse({ error: 'Origin not allowed.' }, 403, null);
  }
  if (!request.body) return jsonResponse({ error: 'Select a video file to upload.' }, 400, origin);

  try {
    const user = await getAdminUser(request);
    const videoId = request.headers.get('X-Video-Id') ?? '';
    if (!/^[A-Za-z0-9-]{1,128}$/.test(videoId)) {
      throw new Response('Invalid Bunny Stream video ID.', { status: 400 });
    }
    if (
      !bunnyLibraryId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(bunnyLibraryId) ||
      !bunnyApiKey
    ) {
      throw new Error('Bunny Stream upload is not configured.');
    }
    const rawSize = request.headers.get('Content-Length');
    const size = rawSize === null ? null : Number(rawSize);
    const auditId = await recordUploadAudit(
      user.id,
      videoId,
      size !== null && Number.isSafeInteger(size) ? size : null,
    );
    const headers = new Headers({
      AccessKey: bunnyApiKey,
      'Content-Type': 'application/octet-stream',
    });
    const contentLength = request.headers.get('Content-Length');
    if (contentLength) headers.set('Content-Length', contentLength);

    let result: Response;
    try {
      result = await fetch(
        `https://video.bunnycdn.com/library/${bunnyLibraryId}/videos/${encodeURIComponent(videoId)}`,
        {
          method: 'PUT',
          headers,
          body: request.body,
        },
      );
    } catch (error) {
      console.error('Bunny upload outcome is not confirmed:', error);
      return jsonResponse({
        error: 'The upload outcome is unknown. Check the Bunny library before retrying.',
      }, 502, origin);
    }
    if (!result.ok) {
      console.error('Bunny Stream rejected a video upload:', result.status);
      if (result.status >= 400 && result.status < 500) {
        await updateUploadAudit(auditId, 'failed');
        return jsonResponse({ error: `Bunny Stream rejected the upload (${result.status}).` }, 502, origin);
      }
      return jsonResponse({
        error: 'Bunny Stream did not confirm the upload outcome. Check the library before retrying.',
      }, 502, origin);
    }
    try {
      await updateUploadAudit(auditId, 'succeeded');
    } catch (error) {
      console.error('Bunny Stream upload succeeded but its audit status could not be updated:', error);
      return jsonResponse({
        error: 'The video uploaded, but its audit status could not be updated. Check the library before retrying.',
      }, 502, origin);
    }
    return jsonResponse({ uploaded: true, videoId }, 200, origin);
  } catch (error) {
    if (error instanceof Response) {
      return jsonResponse({ error: await error.text() }, error.status, origin);
    }
    console.error('Admin Bunny upload failed:', error);
    return jsonResponse({ error: 'Could not upload the Bunny Stream video.' }, 500, origin);
  }
});
