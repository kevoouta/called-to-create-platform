import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

globalThis.Netlify = {
  env: {
    get(name) {
      return {
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_ANON_KEY: 'test-anon-key',
      }[name];
    },
  },
};

const { default: betaGate } = await import('../netlify/edge-functions/beta-gate.ts');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('redirects protected pages without an access cookie to login', async () => {
  let nextCalled = false;
  const response = await betaGate(
    new Request('https://example.test/library.html?view=assets'),
    { next: async () => {
      nextCalled = true;
      return new Response('private');
    } },
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get('location'),
    'https://example.test/login.html?next=%2Flibrary.html%3Fview%3Dassets',
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(nextCalled, false);
});

test('leaves public beta and login pages available without a session', async () => {
  globalThis.fetch = async () => {
    throw new Error('Public routes must not call Supabase.');
  };
  const response = await betaGate(
    new Request('https://example.test/beta.html'),
    { next: async () => new Response('public') },
  );

  assert.equal(await response.text(), 'public');
});

test('protects the static course catalog data file', async () => {
  const response = await betaGate(
    new Request('https://example.test/catalog.js'),
    { next: async () => new Response('private') },
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^https:\/\/example\.test\/login\.html\?/);
});

test('rejects authenticated users whose beta application is not approved', async () => {
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/auth/v1/user')) {
      return Response.json({ id: 'user-id' });
    }
    return Response.json(false);
  };
  const response = await betaGate(
    new Request('https://example.test/explore.html', {
      headers: { cookie: 'c2c_beta_access=valid.jwt.token' },
    }),
    { next: async () => new Response('private') },
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^https:\/\/example\.test\/login\.html\?/);
});

test('serves approved pages without allowing shared-cache storage', async () => {
  let fetchCount = 0;
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    if (String(input).endsWith('/auth/v1/user')) {
      return Response.json({ id: 'user-id' });
    }
    return Response.json(true);
  };
  const response = await betaGate(
    new Request('https://example.test/explore.html', {
      headers: { cookie: 'c2c_beta_access=valid.jwt.token' },
    }),
    { next: async () => new Response('private page') },
  );

  assert.equal(fetchCount, 2);
  assert.equal(await response.text(), 'private page');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vary'), 'Cookie');
});
