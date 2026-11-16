const cookieName = 'c2c_beta_access';
const publicPaths = new Set(['/beta.html', '/login.html', '/privacy.html', '/terms.html']);

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

interface EdgeContext {
  next(): Promise<Response>;
}

function isPublicAsset(pathname: string) {
  if (pathname === '/catalog.js') return false;
  return pathname.startsWith('/.netlify/')
    || /\.(?:avif|css|gif|ico|jpe?g|js|json|map|mjs|png|svg|txt|webp|woff2?)$/i.test(pathname);
}

function getAccessToken(request: Request) {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;

  const value = cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return value && /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

function loginRedirect(request: Request) {
  const currentUrl = new URL(request.url);
  const loginUrl = new URL('/login.html', currentUrl.origin);
  loginUrl.searchParams.set('next', `${currentUrl.pathname}${currentUrl.search}`);
  return new Response(null, {
    status: 302,
    headers: {
      'Cache-Control': 'no-store',
      Location: loginUrl.toString(),
    },
  });
}

function unavailable(message: string) {
  return new Response(message, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function validateUser(token: string, supabaseUrl: string, anonKey: string) {
  return fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
    },
  });
}

async function checkBetaAccess(token: string, supabaseUrl: string, anonKey: string) {
  return fetch(`${supabaseUrl}/rest/v1/rpc/has_beta_access`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
}

export default async function betaGate(request: Request, context: EdgeContext) {
  const url = new URL(request.url);
  const pathname = url.pathname.toLowerCase();
  if (publicPaths.has(pathname) || isPublicAsset(pathname)) return context.next();

  const supabaseUrl = Netlify.env.get('SUPABASE_URL')?.replace(/\/+$/, '');
  const anonKey = Netlify.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    console.error('Beta gate is missing SUPABASE_URL or SUPABASE_ANON_KEY.');
    return unavailable('Beta access is temporarily unavailable.');
  }

  const token = getAccessToken(request);
  if (!token) return loginRedirect(request);

  let userResponse: Response;
  try {
    userResponse = await validateUser(token, supabaseUrl, anonKey);
  } catch (error) {
    console.error('Could not validate the beta access session:', error);
    return unavailable('Beta access is temporarily unavailable.');
  }

  if (userResponse.status === 401 || userResponse.status === 403) {
    return loginRedirect(request);
  }
  if (!userResponse.ok) {
    console.error(`Supabase Auth returned ${userResponse.status} to the beta gate.`);
    return unavailable('Beta access is temporarily unavailable.');
  }

  if (pathname !== '/admin.html') {
    let accessResponse: Response;
    try {
      accessResponse = await checkBetaAccess(token, supabaseUrl, anonKey);
    } catch (error) {
      console.error('Could not check beta approval:', error);
      return unavailable('Beta access is temporarily unavailable.');
    }

    if (!accessResponse.ok) {
      console.error(`Supabase returned ${accessResponse.status} to the beta approval check.`);
      return unavailable('Beta access is temporarily unavailable.');
    }

    let approved: unknown;
    try {
      approved = await accessResponse.json();
    } catch (error) {
      console.error('Supabase returned an invalid beta approval response:', error);
      return unavailable('Beta access is temporarily unavailable.');
    }
    if (approved !== true) return loginRedirect(request);
  }

  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Cookie');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
