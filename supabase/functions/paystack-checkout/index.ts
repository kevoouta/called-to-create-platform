type CheckoutKind = 'course' | 'product';

interface CheckoutRequest {
  action: 'initialize' | 'verify' | 'list_purchases' | 'download_product';
  kind?: CheckoutKind;
  itemIds?: string[];
  callbackUrl?: string;
  reference?: string;
  productId?: string;
  event?: string;
  data?: { reference?: unknown; id?: unknown; status?: unknown };
}

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

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

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required function secret: ${name}`);
  return value;
}

function supabaseEndpoint(path: string) {
  return `${required(supabaseUrl, 'SUPABASE_URL').replace(/\/+$/, '')}/${path}`;
}

async function adminRequest(path: string, init?: RequestInit) {
  const serviceRoleKey = required(supabaseServiceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY');
  const result = await fetch(supabaseEndpoint(`rest/v1/${path}`), {
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
  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new Response('Authentication required.', { status: 401 });

  const response = await fetch(supabaseEndpoint('auth/v1/user'), {
    headers: {
      apikey: required(supabaseAnonKey, 'SUPABASE_ANON_KEY'),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Response('Authentication required.', { status: 401 });
  }
  const user = await response.json();
  if (typeof user.id !== 'string') {
    throw new Response('Authentication required.', { status: 401 });
  }
  return user as { id: string; email?: string };
}

function normalizeItemIds(value: unknown, kind: CheckoutKind): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Response('Select between 1 and 20 items.', { status: 400 });
  }
  if (kind === 'course' && value.length !== 1) {
    throw new Response('Only one course can be purchased at a time.', { status: 400 });
  }
  if (value.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new Response('Invalid item selection.', { status: 400 });
  }
  return value;
}

async function getOrderAmount(
  kind: CheckoutKind,
  itemIds: string[],
) {
  const table = kind === 'course' ? 'courses' : 'products';
  const columns = kind === 'course'
    ? 'id, title, price_kes, is_published'
    : 'id, title, price';
  const query = new URLSearchParams({
    select: columns,
    id: `in.(${itemIds.join(',')})`,
  });
  const data = await adminRequest(`${table}?${query}`);
  if (!data || data.length !== new Set(itemIds).size) {
    throw new Response('One or more selected items are unavailable.', { status: 400 });
  }

  const items = new Map(data.map((item) => [String(item.id), item]));
  let amountMinor = 0;
  for (const id of itemIds) {
    const item = items.get(id);
    if (!item || (kind === 'course' && item.is_published !== true)) {
      throw new Response('One or more selected items are unavailable.', { status: 400 });
    }
    const price = Number(kind === 'course' ? item.price_kes : item.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Response('A selected item has no valid KES price.', { status: 400 });
    }
    amountMinor += Math.round(price * 100);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Response('The checkout total is invalid.', { status: 400 });
  }
  return amountMinor;
}

async function paystackRequest(path: string, init?: RequestInit) {
  const result = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${required(paystackSecretKey, 'PAYSTACK_SECRET_KEY')}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const payload = await result.json();
  if (!result.ok || payload.status !== true) {
    throw new Error(payload.message || 'Paystack request failed.');
  }
  return payload.data;
}

async function initializeCheckout(
  user: { id: string; email?: string },
  body: CheckoutRequest,
) {
  if (body.kind !== 'course' && body.kind !== 'product') {
    throw new Response('Invalid checkout type.', { status: 400 });
  }
  if (!user.email) throw new Response('Your account needs an email to check out.', { status: 400 });

  const itemIds = normalizeItemIds(body.itemIds, body.kind);
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(body.callbackUrl ?? '');
  } catch {
    throw new Response('Checkout return URL is invalid.', { status: 400 });
  }
  if (!allowedOrigins.includes(callbackUrl.origin)) {
    throw new Response('Checkout return URL is not allowed.', { status: 400 });
  }
  if (
    !['https:', 'http:'].includes(callbackUrl.protocol) ||
    callbackUrl.username ||
    callbackUrl.password
  ) {
    throw new Response('Checkout return URL is invalid.', { status: 400 });
  }

  const amountMinor = await getOrderAmount(body.kind, itemIds);
  const reference = `c2c_${crypto.randomUUID()}`;
  const insertedOrders = await adminRequest('payment_orders?select=id', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      user_id: user.id,
      reference,
      item_type: body.kind,
      item_ids: itemIds,
      amount_minor: amountMinor,
      currency: 'KES',
      status: 'pending',
    }]),
  });
  const order = Array.isArray(insertedOrders) ? insertedOrders[0] : null;
  if (!order?.id) throw new Error('Could not create checkout order.');

  try {
    const transaction = await paystackRequest('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: user.email,
        amount: amountMinor,
        currency: 'KES',
        reference,
        callback_url: callbackUrl.toString(),
        metadata: {
          order_id: order.id,
          user_id: user.id,
          item_type: body.kind,
          item_ids: itemIds,
        },
      }),
    });
    return { accessCode: transaction.access_code, reference };
  } catch (error) {
    try {
      await adminRequest(`payment_orders?id=eq.${encodeURIComponent(order.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed' }),
      });
    } catch (updateError) {
      console.error('Could not mark failed checkout order:', updateError);
    }
    throw error;
  }
}

async function verifyCheckout(
  user: { id: string },
  reference: string,
) {
  if (!reference || reference.length > 100) {
    throw new Response('Invalid payment reference.', { status: 400 });
  }
  const query = new URLSearchParams({
    select: '*',
    reference: `eq.${reference}`,
    user_id: `eq.${user.id}`,
    limit: '1',
  });
  const orders = await adminRequest(`payment_orders?${query}`);
  const order = Array.isArray(orders) ? orders[0] : null;
  if (!order) throw new Response('Checkout order not found.', { status: 404 });
  if (order.status === 'refunded') {
    return { status: 'refunded', kind: order.item_type };
  }
  if (order.status === 'paid') return { status: 'success', kind: order.item_type };

  const transaction = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
  const metadata = transaction.metadata ?? {};
  if (
    transaction.status !== 'success' ||
    Number(transaction.amount) !== Number(order.amount_minor) ||
    transaction.currency !== order.currency ||
    transaction.reference !== order.reference ||
    String(metadata.order_id) !== String(order.id) ||
    String(metadata.user_id) !== user.id
  ) {
    if (transaction.status !== 'success') {
      return { status: 'pending', kind: order.item_type };
    }
    throw new Response('Payment details did not match this order.', { status: 400 });
  }

  const completedKind = await adminRequest('rpc/complete_payment_order', {
    method: 'POST',
    body: JSON.stringify({
      p_reference: order.reference,
      p_transaction_id: transaction.id,
    }),
  });
  return { status: 'success', kind: completedKind };
}

async function getPurchasedProductIds(userId: string) {
  const query = new URLSearchParams({
    select: 'item_ids',
    user_id: `eq.${userId}`,
    item_type: 'eq.product',
    status: 'eq.paid',
  });
  const orders = await adminRequest(`payment_orders?${query}`);
  const productIds = new Set<string>();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!Array.isArray(order.item_ids)) continue;
    for (const id of order.item_ids) {
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        productIds.add(id);
      }
    }
  }
  return [...productIds];
}

async function listPurchasedProducts(user: { id: string }) {
  const productIds = await getPurchasedProductIds(user.id);
  if (productIds.length === 0) return { products: [] };

  const query = new URLSearchParams({
    select: 'id,title,description,category,image_url,storage_path',
    id: `in.(${productIds.join(',')})`,
  });
  const products = await adminRequest(`products?${query}`);
  return {
    products: (Array.isArray(products) ? products : []).map((product) => ({
      id: String(product.id),
      title: product.title,
      description: product.description,
      category: product.category,
      image_url: product.image_url,
      available: typeof product.storage_path === 'string' && product.storage_path.length > 0,
    })),
  };
}

async function createProductDownload(user: { id: string }, productId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(productId)) {
    throw new Response('Invalid product selection.', { status: 400 });
  }
  const productIds = await getPurchasedProductIds(user.id);
  if (!productIds.includes(productId)) {
    throw new Response('This product is not available in your purchases.', { status: 403 });
  }

  const query = new URLSearchParams({
    select: 'title,storage_path',
    id: `eq.${productId}`,
    limit: '1',
  });
  const products = await adminRequest(`products?${query}`);
  const product = Array.isArray(products) ? products[0] : null;
  if (!product || typeof product.storage_path !== 'string' || !product.storage_path.trim()) {
    throw new Response('The download for this product is not configured yet.', { status: 409 });
  }

  const path = product.storage_path.trim();
  if (
    path.length > 1024 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part: string) => !part || part === '.' || part === '..')
  ) {
    throw new Error('The configured product download path is invalid.');
  }

  const baseUrl = required(supabaseUrl, 'SUPABASE_URL').replace(/\/+$/, '');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const signedResult = await fetch(
    `${baseUrl}/storage/v1/object/sign/shop-deliverables/${encodedPath}`,
    {
      method: 'POST',
      headers: {
        apikey: required(supabaseServiceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY'),
        Authorization: `Bearer ${required(supabaseServiceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 600 }),
    },
  );
  const signedPayload = await signedResult.json();
  if (
    !signedResult.ok ||
    typeof signedPayload.signedURL !== 'string' ||
    !signedPayload.signedURL.startsWith('/object/sign/shop-deliverables/')
  ) {
    throw new Error(`Could not create product download link (${signedResult.status}).`);
  }

  const signedUrl = new URL(`${baseUrl}/storage/v1${signedPayload.signedURL}`);
  const fileName = path.split('/').pop() || String(product.title || 'download');
  signedUrl.searchParams.set('download', fileName);
  try {
    await adminRequest('rpc/record_site_monthly_metric', {
      method: 'POST',
      body: JSON.stringify({
        p_metric_key: 'shop_download_link',
        p_route: '/library.html',
        p_value: null,
      }),
    });
  } catch (error) {
    console.error('Could not record shop download metric:', error);
  }
  return { downloadUrl: signedUrl.toString() };
}

async function verifyWebhookSignature(rawBody: string, signature: string) {
  const secret = required(paystackSecretKey, 'PAYSTACK_SECRET_KEY');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)),
  );
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (signature.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    if (origin && !allowedOrigins.includes(origin)) {
      return response({ error: 'Origin not allowed.' }, 403, origin);
    }
    const headers = new Headers({
      'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin',
    });
    if (origin && allowedOrigins.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
    }
    return new Response('ok', { headers });
  }
  if (request.method !== 'POST') {
    return response({ error: 'Method not allowed.' }, 405, origin);
  }
  const isPaystackWebhook = request.headers.has('x-paystack-signature');
  if (origin && !allowedOrigins.includes(origin) && !isPaystackWebhook) {
    return response({ error: 'Origin not allowed.' }, 403, origin);
  }

  try {
    const rawBody = await request.text();
    const paystackSignature = request.headers.get('x-paystack-signature');
    let body: CheckoutRequest;
    try {
      body = JSON.parse(rawBody) as CheckoutRequest;
    } catch {
      throw new Response('Invalid request body.', { status: 400 });
    }

    if (paystackSignature) {
      if (!await verifyWebhookSignature(rawBody, paystackSignature)) {
        return response({ error: 'Invalid Paystack signature.' }, 401, origin);
      }
      if (body.event === 'charge.success') {
        const reference = typeof body.data?.reference === 'string' ? body.data.reference : '';
        if (!reference) throw new Response('Webhook is missing a payment reference.', 400);
        const query = new URLSearchParams({
          select: 'user_id',
          reference: `eq.${reference}`,
          limit: '1',
        });
        const orders = await adminRequest(`payment_orders?${query}`);
        const order = Array.isArray(orders) ? orders[0] : null;
        if (!order) {
          console.warn('Paystack webhook referenced an unknown payment order:', reference);
          return response({ received: true }, 200, origin);
        }
        const verification = await verifyCheckout({ id: order.user_id }, reference);
        if (verification.status !== 'success' && verification.status !== 'refunded') {
          throw new Error('Paystack reported a successful charge that is not yet verifiable.');
        }
      } else if (body.event === 'refund.processed' || body.event === 'refund.failed') {
        const refundId = body.data?.id == null ? '' : String(body.data.id);
        if (refundId) {
          const query = new URLSearchParams({
            select: 'order_id',
            paystack_refund_id: `eq.${refundId}`,
            limit: '1',
          });
          const refunds = await adminRequest(`admin_payment_refunds?${query}`);
          const refund = Array.isArray(refunds) ? refunds[0] : null;
          if (refund) {
            await adminRequest('rpc/admin_update_payment_refund_by_provider_id', {
              method: 'POST',
              body: JSON.stringify({
                p_paystack_refund_id: refundId,
                p_status: body.event === 'refund.processed' ? 'processed' : 'failed',
              }),
            });
          } else {
            console.warn('Paystack refund webhook referenced an unknown refund:', refundId);
          }
        } else {
          console.warn('Paystack refund webhook did not include a refund ID.');
        }
      }
      return response({ received: true }, 200, origin);
    }

    const user = await getAuthenticatedUser(request);
    const result = body.action === 'initialize'
      ? await initializeCheckout(user, body)
      : body.action === 'verify'
      ? await verifyCheckout(user, body.reference ?? '')
      : body.action === 'list_purchases'
      ? await listPurchasedProducts(user)
      : body.action === 'download_product'
      ? await createProductDownload(user, body.productId ?? '')
      : (() => { throw new Response('Invalid checkout action.', { status: 400 }); })();
    return response(result, 200, origin);
  } catch (error) {
    if (error instanceof Response) {
      return response({ error: await error.text() }, error.status, origin);
    }
    console.error('Paystack checkout error:', error);
    return response({ error: 'Checkout could not be completed. Please try again.' }, 500, origin);
  }
});
