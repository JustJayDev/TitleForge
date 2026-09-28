// ============================================================
// TitleForge — DevVault client SDK.
// ------------------------------------------------------------
// No credential of any kind lives in this file or in the shipped
// bundle. The AI provider key is held by the Vault and used
// server-side; the browser only ever sends video metadata.
//
// Authorization (run once per session from the app):
//   window.location = vault.authorizeUrl()
//   -> operator approves in the Vault UI
//   -> redirect back with ?dv_code=...
//   -> vault.exchangeCode(code) -> in-memory access token (1h)
// ============================================================

const DEFAULT_VAULT = 'https://devvault.justjaydev.workers.dev';

class DevVaultClient {
  constructor({
    baseUrl = DEFAULT_VAULT,
    redirectUri = (typeof location !== 'undefined' ? location.origin + location.pathname + location.search : ''),
    project = 'youtube-ai',
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.redirectUri = redirectUri;
    this.project = project;
    this._token = null;          /* in-memory only, never persisted */
    this._expiresAt = 0;
  }

  /* ---------- authorization ---------- */
  authorizeUrl(scopes = ['title:forge']) {
    const u = new URL(this.baseUrl + '/api/oauth/authorize');
    u.searchParams.set('project', this.project);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('scopes', scopes.join(','));
    return u.toString();
  }

  /* the code comes back as a ?dv_code= query param (the Vault sets it
     as a query string so it never clobbers a hash-based route). */
  static codeFromLocation(loc = (typeof location !== 'undefined' ? location : null)) {
    if (!loc) return null;
    const fromSearch = /dv_code=([^&]+)/.exec(loc.search || '');
    if (fromSearch) return decodeURIComponent(fromSearch[1]);
    const fromHash = /dv_code=([^&]+)/.exec(loc.hash || '');
    if (fromHash) return decodeURIComponent(fromHash[1]);
    return null;
  }

  /* Reconstruct the redirect_uri that was originally authorized.
     The Vault appends dv_code + project to the URL when it redirects
     back, so this strips exactly those two params. */
  static redirectUriFromLocation(loc = (typeof location !== 'undefined' ? location : null)) {
    if (!loc) return '';
    const u = new URL(loc.href);
    u.searchParams.delete('dv_code');
    u.searchParams.delete('project');
    return u.origin + u.pathname + u.search;
  }

  async exchangeCode(code, redirectUri = this.redirectUri) {
    const r = await fetch(this.baseUrl + '/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Vault token exchange failed (HTTP ${r.status})`);
    this._token = j.access_token;
    this._expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    /* scrub the code from the URL so it can't be read from history */
    if (typeof history !== 'undefined' && history.replaceState) {
      try {
        const clean = new URL(location.href);
        clean.searchParams.delete('dv_code');
        clean.searchParams.delete('project');
        history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
      } catch { /* */ }
    }
    return j;
  }

  isAuthenticated() {
    return !!this._token && Date.now() < this._expiresAt;
  }

  logout() {
    this._token = null;
    this._expiresAt = 0;
  }

  /* ---------- transport ---------- */
  async _call(path, body) {
    if (!this.isAuthenticated()) {
      throw new Error('Not authorized with the Vault. Connect it in the AI step first.');
    }
    const r = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok) throw new Error(j.error || j.raw || `HTTP ${r.status}`);
    return j;
  }

  /* ---------- Title forge (proxied, key never exposed) ----------
     Sends ONLY video metadata + style. Returns an array of titles
     (or null slots where the model gave nothing back). */
  async forgeTitles(videos, style) {
    const r = await this._call('/api/proxy/forge/titles', { videos, style });
    return r.titles;
  }
}

export { DevVaultClient };