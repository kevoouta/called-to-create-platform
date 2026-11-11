const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const metricKeys = new Set(['page_view', 'lcp_ms', 'cls', 'inp_ms', 'fcp_ms', 'ttfb_ms']);
const allowedRoutes = new Set([
  '/',
  '/index.html',
  '/explore.html',
  '/how-it-works.html',
  '/course.html',
  '/library.html',
  '/privacy.html',
  '/terms.html',
  '/search.html',
  '/shop.html',
  '/support.html',
]);

class ValidationError extends Error {}

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

function validateMetric(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Invalid metric.');
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.metric !== 'string' ||
    !metricKeys.has(body.metric) ||
    typeof body.route !== 'string' ||
    !allowedRoutes.has(body.route)
  ) {
    throw new ValidationError('Invalid metric.');
  }
  if (
    body.metric === 'page_view'
      ? body.value !== undefined && body.value !== null
      : typeof body.value !== 'number' ||
        !Number.isFinite(body.value) ||
        body.value < 0 ||
        body.value > 600000
  ) {
    throw new ValidationError('Invalid metric value.');
  }
  return {
    metric: body.metric,
    route: body.route || '/',
    value: body.metric === 'page_view' ? null : body.value as number,
  };
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
    response.headers.set('Access-Control-Allow-Headers', 'apikey, content-type');
    response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return response;
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, origin);
  }
  if (!origin || !allowedOrigins.includes(origin)) {
    return jsonResponse({ error: 'Origin not allowed.' }, 403, null);
  }
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error('Site analytics is missing its Supabase service configuration.');
    return jsonResponse({ error: 'Analytics is temporarily unavailable.' }, 503, origin);
  }
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (contentLength > 2048) {
    return jsonResponse({ error: 'Metric payload is too large.' }, 413, origin);
  }

  try {
    const rawBody = await request.text();
    if (rawBody.length > 2048) {
      return jsonResponse({ error: 'Metric payload is too large.' }, 413, origin);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new ValidationError('Invalid metric request body.');
    }
    const metric = validateMetric(payload);
    const result = await fetch(
      `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/record_site_monthly_metric`,
      {
        method: 'POST',
        headers: {
          apikey: supabaseServiceRoleKey,
          Authorization: `Bearer ${supabaseServiceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_metric_key: metric.metric,
          p_route: metric.route,
          p_value: metric.value,
        }),
      },
    );
    if (!result.ok) {
      const error = await result.text();
      console.error('Could not record site metric:', result.status, error);
      return jsonResponse({ error: 'Could not record site metric.' }, 502, origin);
    }
    return jsonResponse({ recorded: true }, 200, origin);
  } catch (error) {
    if (error instanceof ValidationError) {
      return jsonResponse({ error: error.message || 'Invalid metric.' }, 400, origin);
    }
    console.error('Unexpected site analytics error:', error);
    return jsonResponse({ error: 'Analytics is temporarily unavailable.' }, 500, origin);
  }
});
