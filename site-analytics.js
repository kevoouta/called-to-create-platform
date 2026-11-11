(() => {
  const SUPABASE_URL = 'https://ecbftpfbbfvcxreszsfo.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_AQZBPX4R8Q4IxQnKO2euYw_IWwlxlb9';
  const routeAliases = {
    '/': '/',
    '/explore': '/explore.html',
    '/how-it-works': '/how-it-works.html',
    '/course': '/course.html',
    '/library': '/library.html',
    '/privacy': '/privacy.html',
    '/terms': '/terms.html',
    '/search': '/search.html',
    '/shop': '/shop.html',
    '/support': '/support.html',
  };
  const route = routeAliases[window.location.pathname] ||
    (window.location.pathname.endsWith('.html') ? window.location.pathname : '/');
  const observed = new Set();
  const values = {};
  let cumulativeLayoutShift = 0;
  let largestContentfulPaint = 0;
  let interactionToNextPaint = 0;

  function record(metric, value) {
    if (observed.has(metric)) return;
    observed.add(metric);
    fetch(`${SUPABASE_URL}/functions/v1/site-analytics`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ metric, route, ...(value === undefined ? {} : { value }) }),
      keepalive: true,
    }).then((response) => {
      if (!response.ok) console.error('Could not record site analytics metric:', response.status);
    }).catch((error) => {
      console.error('Could not record site analytics metric:', error);
    });
  }

  record('page_view');

  const navigation = performance.getEntriesByType('navigation')[0];
  if (navigation && navigation.responseStart >= navigation.requestStart) {
    values.ttfb_ms = navigation.responseStart - navigation.requestStart;
  }

  function observe(type, callback, options) {
    if (
      typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes?.includes(type)
    ) return;
    const observer = new PerformanceObserver(callback);
    observer.observe({ type, buffered: true, ...options });
  }

  observe('paint', (entries) => {
    for (const entry of entries.getEntries()) {
      if (entry.name === 'first-contentful-paint') values.fcp_ms = entry.startTime;
    }
  });
  observe('largest-contentful-paint', (entries) => {
    for (const entry of entries.getEntries()) {
      largestContentfulPaint = entry.startTime;
    }
  });
  observe('layout-shift', (entries) => {
    for (const entry of entries.getEntries()) {
      if (!entry.hadRecentInput) cumulativeLayoutShift += entry.value;
    }
  });
  observe('event', (entries) => {
    for (const entry of entries.getEntries()) {
      interactionToNextPaint = Math.max(interactionToNextPaint, entry.duration);
    }
  }, { durationThreshold: 40 });

  function flush() {
    if (largestContentfulPaint > 0) record('lcp_ms', largestContentfulPaint);
    if (!observed.has('cls')) record('cls', cumulativeLayoutShift);
    if (interactionToNextPaint > 0) record('inp_ms', interactionToNextPaint);
    for (const [metric, value] of Object.entries(values)) {
      if (value > 0) record(metric, value);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  }, { once: true });
  window.addEventListener('pagehide', flush, { once: true });
})();
