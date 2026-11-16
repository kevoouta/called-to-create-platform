(() => {
  const client = window.supabaseClient;
  if (!client?.auth?.onAuthStateChange) return;

  const cookieName = 'c2c_beta_access';
  const clearCookie = () => {
    document.cookie = `${cookieName}=; Path=/; Max-Age=0; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  };

  window.syncBetaSessionCookie = (session) => {
    const expiresAt = Number(session?.expires_at);
    const maxAge = Math.floor(expiresAt - Date.now() / 1000);
    if (!session?.access_token || !Number.isFinite(maxAge) || maxAge <= 0) {
      clearCookie();
      return;
    }

    document.cookie = `${cookieName}=${session.access_token}; Path=/; Max-Age=${maxAge}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  };

  client.auth.onAuthStateChange((_event, session) => {
    window.syncBetaSessionCookie(session);
  });
})();
