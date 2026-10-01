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

/* APIs are inconsistent about the error field: some send a string,
   some an object, some a nested {error:{message}}. Normalise all of
   them into a readable sentence so the UI never shows "[object Object]". */
function errText(j, status) {
  const fallback = 'HTTP ' + status;
  if (!j || typeof j !== 'object') {
    return typeof j === 'string' && j.trim() ? j.trim() : fallback;
  }
  const pick = (v) => {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      if (typeof v.message === 'string' && v.message.trim()) return v.message.trim();
      if (typeof v.error === 'string' && v.error.trim()) return v.error.trim();
      if (v.error && typeof v.error === 'object' && typeof v.error.message === 'string') {
        return v.error.message.trim();
      }
    }
    return '';
  };
  return pick(j.error) || pick(j.message) || pick(j.raw) || fallback;
}

/* ---------- in-memory token store ----------
   The Google access token lives HERE and nowhere else: a module-level
   variable inside the JS heap. It is never written to localStorage,
   sessionStorage, cookies or IndexedDB, so it cannot survive a reload
   and cannot be read by anything that does not already have script
   execution in this page.

   This mirrors the DevVaultClient._token pattern below and the PixVault
   reference client: same-tab memory only, cleared on disconnect. */

// Refresh this many ms BEFORE actual expiry, so a token is never handed
// to YouTube in the moment it lapses.
const EXPIRY_MARGIN_MS = 60_000;

let ytToken = null;      // Google access token, memory only
let ytExpiresAt = 0;

export function setToken(t, expiresInSeconds = 3600) {
  ytToken = t || null;
  ytExpiresAt = ytToken ? Date.now() + (expiresInSeconds || 3600) * 1000 : 0;
  return ytToken;
}

export function getToken() {
  return ytToken;
}

export function clearToken() {
  ytToken = null;
  ytExpiresAt = 0;
}

/* True only when a token exists AND has not expired (minus margin). */
export function isTokenValid() {
  return !!ytToken && Date.now() < (ytExpiresAt - EXPIRY_MARGIN_MS);
}

/* Milliseconds until expiry, or 0 when there is no token. */
export function tokenTtlMs() {
  if (!ytToken) return 0;
  return Math.max(0, ytExpiresAt - Date.now());
}

/* NOTE — why there is no silent refresh:
   Google OAuth is running the IMPLICIT flow (response_type: 'token').
   That flow NEVER issues a refresh_token, so once this 1-hour access
   token expires it cannot be renewed without a new user consent round
   trip. There is no code that could fix this client-side; it would
   require migrating to response_type: 'code' + PKCE and a client secret,
   which would break the "zero-dependency, no backend" property that is
   TitleForge's whole point.

   TODO(migration): if the Google token ever needs to outlive an hour,
   switch to the authorization-code + PKCE flow in startOAuth(). Until
   then, callers must re-prompt via startOAuth() / useManualToken(). */

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
    if (!r.ok) throw new Error(errText(j, r.status));
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
    if (!r.ok) throw new Error(errText(j, r.status));
    return j;
  }

  /* ---------- Title forge (proxied, key never exposed) ----------
     Sends ONLY video metadata + style. Returns an array of titles
     (or null slots where the model gave nothing back). */
  async forgeTitles(videos, style) {
    const r = await this._call('/api/proxy/forge/titles', { videos, style });
    if (!r || !Array.isArray(r.titles)) {
      throw new Error('Vault returned no titles array. Check the Vault project policy and secret.');
    }
    return r.titles;
  }
}

export { DevVaultClient };