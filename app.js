import { DevVaultClient } from './vault.js';

/* =============================================================
 * TitleForge — core app logic
 * Connect -> Fetch -> Forge -> Review -> Apply (-> Undo)
 * YouTube Data API v3 + Vault-proxied AI engine.
 * ============================================================= */

const $ = (id) => document.getElementById(id);

/* --- State --- */
let token = '';
let videos = [];
let forged = [];
let appliedHistory = [];
let connectedChannel = null;
let fetchAbort = false;
let applyAbort = false;
let forgeAbort = false;

let _vault = null;
function getVault() {
  if (!_vault) {
    _vault = new DevVaultClient({
      redirectUri: location.origin + location.pathname,
      project: 'youtube-ai',
    });
  }
  return _vault;
}

/* --- Config --- */
const CONFIG = {
  CLIENT_ID: '135469633703-c95kvlba4i5qiuibnnpn06g9ns7aamfe.apps.googleusercontent.com',
  REDIRECT_URI: window.location.origin + window.location.pathname,
  SCOPES: 'https://www.googleapis.com/auth/youtube.force-ssl',
};

const QUOTA_UPDATE = 50;
const APPLY_CONCURRENCY = 3;
const FORGE_BATCH = 20;

/* --- UI helpers --- */
function show(id) { $(id)?.classList.remove('hidden'); }
function hide(id) { $(id)?.classList.add('hidden'); }
function setStatus(id, msg) { const el = $(id); if (el) el.textContent = msg; }

function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-busy');
    if (label) btn.textContent = label;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

/* Never surface a raw object in the UI — always a readable string. */
function msgOf(e) {
  if (!e) return 'Unknown error.';
  if (typeof e === 'string') return e;
  if (e instanceof Error && e.message) return e.message;
  if (typeof e.message === 'string' && e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function toast(msg, type = 'info') {
  const box = $('toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 350);
  }, type === 'error' ? 7000 : 4200);
}

const STEP_ORDER = { connect: 0, fetch: 1, forge: 2, apply: 3 };
function paintRail(active) {
  document.querySelectorAll('.rail-step').forEach((el) => {
    const name = el.dataset.step;
    const on = name === active;
    el.classList.toggle('on', on);
    el.classList.toggle('done', (STEP_ORDER[name] ?? 0) < (STEP_ORDER[active] ?? 99));
    if (on) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  });
}

/* --- OAuth --- */
function startOAuth() {
  if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.startsWith('PASTE_')) {
    toast('OAuth not configured yet — add CLIENT_ID in app.js, or paste a token below.', 'warn');
    return;
  }
  if (!CONFIG.CLIENT_ID.includes('.apps.googleusercontent.com')) {
    toast('CLIENT_ID in app.js looks invalid — check your Google Cloud credentials.', 'error');
    return;
  }
  const params = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    response_type: 'token',
    scope: CONFIG.SCOPES,
    include_granted_scopes: 'true',
    prompt: 'consent',
  });
  window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

function handleRedirect() {
  const h = new URLSearchParams(window.location.hash.substring(1));
  const t = h.get('access_token');
  if (t) {
    token = t;
    sessionStorage.setItem('tf_token', t);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
  }
  return false;
}

function useManualToken() {
  const t = $('token-input').value.trim();
  if (!t) { toast('Paste an access token first.', 'warn'); return; }
  token = t;
  sessionStorage.setItem('tf_token', t);
  connected();
}

async function connected() {
  hide('step-connect');
  show('btn-disconnect');
  setStatus('connected-ok', '✓ Connected');
  show('connected-ok');
  paintRail('fetch');
  setStatus('fetch-status', '');
  try {
    const data = await ytFetch('channels?part=snippet&mine=true');
    const ch = data.items?.[0];
    if (ch) {
      connectedChannel = {
        name: ch.snippet.title,
        thumb: ch.snippet.thumbnails?.default?.url,
      };
      setStatus('connected-ok', '✓ ' + connectedChannel.name);
      document.title = connectedChannel.name + ' · TitleForge';
    }
  } catch (e) {
    toast(msgOf(e), 'error');
    return;
  }
  show('step-fetch');
}

function disconnect() {
  token = '';
  sessionStorage.removeItem('tf_token');
  videos = []; forged = []; appliedHistory = []; connectedChannel = null;
  fetchAbort = false; applyAbort = false; forgeAbort = false;
  hide('step-fetch'); hide('step-ai'); hide('step-preview');
  hide('btn-disconnect'); hide('btn-undo');
  show('step-connect');
  setStatus('connected-ok', '');
  setStatus('preview-count', '');
  document.title = 'TitleForge — App';
  paintRail('connect');
  toast('Disconnected. Token cleared from this tab.', 'info');
}

async function ytFetch(path) {
  let res;
  try {
    res = await fetch('https://www.googleapis.com/youtube/v3/' + path, {
      headers: { Authorization: 'Bearer ' + token },
    });
  } catch (e) {
    throw new Error('Network error reaching YouTube. Check your connection.');
  }
  if (res.status === 401) {
    sessionStorage.removeItem('tf_token');
    token = '';
    throw new Error('Your Google session expired. Please reconnect.');
  }
  if (res.status === 403) {
    const e = await res.json().catch(() => ({}));
    const reason = e.error?.errors?.[0]?.reason || '';
    if (reason.includes('quotaExceeded')) {
      throw new Error('YouTube API quota exhausted for today. Try after midnight PT.');
    }
    if (reason.includes('forbidden')) {
      throw new Error('This token lacks permission. Reconnect and accept all scopes.');
    }
    throw new Error(e.error?.message || 'YouTube API refused the request (403).');
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || 'YouTube API error ' + res.status);
  }
  return res.json();
}

async function loadVideos() {
  const btn = $('btn-fetch');
  if (!token) { toast('Connect your channel first.', 'warn'); return; }
  busy(btn, true, 'Loading…');
  fetchAbort = false;
  show('fetch-progress');
  setBar('fetch-bar', 0);
  setStatus('fetch-status', 'Loading videos…');
  show('btn-stop-fetch');
  videos = [];
  let page = '';
  let pages = 0;

  try {
    do {
      const data = await ytFetch(
        'videos?part=snippet,statistics,contentDetails&mine=true&maxResults=50' +
        (page ? '&pageToken=' + encodeURIComponent(page) : '')
      );
      if (fetchAbort) break;
      for (const v of data.items || []) {
        videos.push({
          id: v.id,
          title: v.snippet.title,
          description: v.snippet.description || '',
          views: +(v.statistics?.viewCount || 0),
          likes: +(v.statistics?.likeCount || 0),
          comments: +(v.statistics?.commentCount || 0),
          duration: v.contentDetails?.duration || '',
          published: v.snippet.publishedAt,
        });
      }
      page = data.nextPageToken || '';
      pages++;
      setBar('fetch-bar', page ? Math.min(95, 10 + pages * 12) : 100);
      setStatus('fetch-status', 'Loaded ' + videos.length + ' videos…');
    } while (page && !fetchAbort);
  } catch (e) {
    hide('fetch-progress');
    hide('btn-stop-fetch');
    busy(btn, false);
    setStatus('fetch-status', '');
    toast(msgOf(e), 'error');
    return;
  }
  hide('fetch-progress');
  hide('btn-stop-fetch');
  busy(btn, false);

  if (fetchAbort) {
    setStatus('fetch-status', 'Stopped · ' + videos.length + ' loaded so far');
    if (!videos.length) return;
  } else if (!videos.length) {
    setStatus('fetch-status', 'No videos found on this channel.');
    toast('No videos found for this account.', 'warn');
    return;
  } else {
    setStatus('fetch-status', 'Loaded ' + videos.length + ' videos');
  }

  hide('step-fetch');
  show('step-ai');
  paintRail('forge');
  setStatus('ai-count', videos.length + ' video' + (videos.length === 1 ? '' : 's') + ' queued');
}

function setBar(id, pct) {
  const bar = $(id);
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/* --- AI Engine (Vault-backed, concurrent) --- */
/* The AI key is never in this bundle. The browser sends only video
   metadata + style to the Vault, which holds the key server-side.
   Batching of 20 cuts request count ~20x. */
async function forgeTitles() {
  const style = $('style').value;
  const btn = $('btn-forge');

  if (!videos.length) { toast('Load your videos first.', 'warn'); return; }
  if (!getVault().isAuthenticated()) {
    toast('Connect the Vault first — it holds the AI key.', 'warn');
    $('btn-vault').focus();
    return;
  }

  forgeAbort = false;
  busy(btn, true, 'Forging...');
  show('btn-stop-forge');
  show('forge-progress');
  setBar('forge-bar', 0);
  setStatus('forge-status', 'Forging titles...');

  forged = videos.map((v) => ({
    id: v.id, oldTitle: v.title, newTitle: v.title,
    seoOld: seoScore(v.title), seoNew: seoScore(v.title),
    selected: true, applied: false,
  }));

  const total = forged.length;
  const batches = [];
  for (let i = 0; i < total; i += FORGE_BATCH) {
    batches.push(videos.slice(i, i + FORGE_BATCH).map((v, j) => ({
      i: i + j,
      title: v.title,
      description: v.description,
      views: v.views,
      likes: v.likes,
      comments: v.comments,
    })));
  }

  let done = 0;
  let failedBatches = 0;
  let lastError = '';
  const queue = batches.slice();
  const CONCURRENCY = Math.min(3, queue.length);

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !forgeAbort) {
      const batch = queue.shift();
      try {
        const titles = await getVault().forgeTitles(batch, style);
        if (!Array.isArray(titles) || titles.length !== batch.length) {
          throw new Error('Vault returned ' + (Array.isArray(titles) ? titles.length : 'no') +
            ' titles for ' + batch.length + ' videos.');
        }
        for (let k = 0; k < batch.length; k++) {
          const idx = batch[k].i;
          const cleaned = cleanTitle(titles[k]);
          if (cleaned) {
            forged[idx].newTitle = cleaned;
            forged[idx].seoNew = seoScore(cleaned);
          }
        }
      } catch (e) {
        failedBatches++;
        lastError = msgOf(e);
      }
      done += batch.length;
      setBar('forge-bar', Math.min(99, Math.round((done / total) * 100)));
      setStatus('forge-status', 'Forging ' + Math.min(done, total) + '/' + total + '...');
    }
  });
  await Promise.all(workers);

  hide('forge-progress');
  hide('btn-stop-forge');
  busy(btn, false);

  if (forgeAbort) setStatus('forge-status', 'Forge stopped.');

  const changed = forged.filter((f) => f.newTitle !== f.oldTitle).length;
  const stopped = forgeAbort;

  if (!changed) {
    hide('step-ai');
    show('step-preview');
    paintRail('apply');
    setStatus('forge-status', '');
    toast(failedBatches
      ? 'No titles were generated - every batch failed. ' + lastError
      : 'The model returned titles identical to the originals. Try another style.', 'error');
    return;
  }

  /* Partial failures must be visible, but never stack two toasts
     for a single run — the user only needs one verdict. */
  if (stopped) {
    toast('Forge stopped - ' + changed + ' of ' + forged.length + ' titles ready below.', 'warn');
  } else if (failedBatches) {
    toast(changed + ' titles forged, but ' + failedBatches + ' batch' +
      (failedBatches === 1 ? '' : 'es') + ' failed. ' + lastError, 'warn');
  } else {
    toast('Forged ' + changed + ' titles. Review before applying.', 'ok');
  }

  renderPreview();
  hide('step-ai');
  show('step-preview');
  paintRail('apply');

  const lift = avgLift();
  const se = $('preview-seo');
  if (lift > 0) {
    const ch = forged.filter((f) => f.newTitle !== f.oldTitle);
    se.textContent = 'avg SEO ' + Math.round(avgSeo(ch.map((f) => f.seoOld))) +
      ' -> ' + Math.round(avgSeo(ch.map((f) => f.seoNew))) + ' (+' + lift + ')';
    se.className = 'status seo-good';
  } else {
    se.textContent = changed + ' of ' + forged.length + ' titles changed';
    se.className = 'status';
  }
  show('preview-seo');
}

function stopForge() {
  if (!forgeAbort) {
    forgeAbort = true;
    setStatus('forge-status', 'Stopping after the current batch...');
  }
}

function stopFetch() {
  if (!fetchAbort) {
    fetchAbort = true;
    setStatus('fetch-status', 'Stopping...');
  }
}

function avgSeo(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }
function avgLift() {
  const changed = forged.filter((f) => f.newTitle !== f.oldTitle);
  if (!changed.length) return 0;
  return Math.round(avgSeo(changed.map((f) => f.seoNew)) - avgSeo(changed.map((f) => f.seoOld)));
}

/* Normalise model output into a single clean title line.
   Guards YouTube titles against: reasoning leakage, "Title:" prefixes,
   numbering, quote wrapping, hashtag soup, meta commentary, >100 chars. */
function cleanTitle(raw) {
  let t = String(raw == null ? '' : raw);
  t = t.replace(/[\u00A0\u1680\u180E\u2000-\u200F\u202F\u205F\u3000\u3164\uFFA0\uFEFF]/g, ' ');
  t = t.trim();
  if (!t) return '';

  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.replace(/^<\/?think[^>]*>/i, '').trim();

  const firstLine = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  t = firstLine;

  /* Strip leading list markers, with or without a trailing space. */
  t = t.replace(/^(?:[-*@\u2022]{1,3}|\d{1,2}[.)])\s*/, '');
  t = t.replace(/^(?:new\s+)?(?:title|suggested\s+title)\s*[:\-\u2013]\s*/i, '');
  t = t.split(/[|\uFF5C]/)[0];

  /* Trailing junk must go before quote-stripping, otherwise a quote
     stranded by a stripped "-" is never seen as a wrapping quote. */
  t = t.replace(/\s*[([]\s*\d+\s*(?:chars?|characters?)\b[^)\]]*[)\]]\s*$/i, '');
  t = t.replace(/\s*\[[\d\s]*(?:chars?|characters?|title)\b[^\]]*\]\s*$/i, '');
  t = t.replace(/#[\w\u00C0-\uFFFF]+/g, '');
  t = t.replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/^[\-\u2013\u2014|,.:;]+\s*/, '').replace(/\s*[\-\u2013\u2014|,.:;]+$/, '').trim();

  for (let i = 0; i < 3; i++) {
    t = t.replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, '').trim();
  }

  /* Collapse doubled inner quotes (models emit these when nesting). */
  t = t.replace(/(["'\u201C\u201D\u2018\u2019])\1+/g, '$1');

  /* Second pass: markers can be exposed once quotes are gone. */
  t = t.replace(/^(?:[-*@\u2022]{1,3}|\d{1,2}[.)])\s*/, '');
  t = t.replace(/^[\-\u2013\u2014|,.:;*@]+/, '').replace(/[\-\u2013\u2014|,.;:*@]+$/, '').trim();

  if (!t) return '';
  if (t.length > 100) t = t.slice(0, 100).replace(/\s+\S*$/, '').trim();
  return t;
}

function seoScore(title) {
  const t = String(title == null ? '' : title);
  if (!t.trim()) return 0;
  let s = 40;
  const len = t.length;
  if (len >= 20 && len <= 70) s += 20;
  if (len > 70) s -= 10;
  if (len < 12) s -= 10;
  if (/\b(how|why|best|top|vs|guide|tutorial|tips|tricks|secret|free|easy|new|ultimate)\b/i.test(t)) s += 15;
  if (/[0-9]/.test(t)) s += 10;
  if (/[!?]/.test(t)) s += 5;
  if (/[A-Z]/.test(t)) s += 5;
  if (t === t.toUpperCase() && len > 5) s -= 10;
  if (/\s{2,}/.test(t)) s -= 5;
  return Math.max(0, Math.min(99, Math.round(s)));
}

/* --- Preview table --- */
function visibleRows() {
  const q = ($('search') && $('search').value || '').toLowerCase().trim();
  const onlyChanged = $('only-changed') && $('only-changed').checked;
  const out = [];
  for (let i = 0; i < forged.length; i++) {
    const f = forged[i];
    if (q && (f.oldTitle + ' ' + f.newTitle).toLowerCase().indexOf(q) === -1) continue;
    if (onlyChanged && f.newTitle === f.oldTitle) continue;
    out.push({ f: f, i: i });
  }
  return out;
}

function renderPreview() {
  const tbody = document.querySelector('#preview-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const rows = visibleRows();

  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'empty-cell';
    td.textContent = forged.length
      ? 'No titles match this filter. Clear the search or untick Only changed.'
      : 'Nothing to review yet - forge some titles first.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    updateSelectionCount();
    return;
  }

  for (let r = 0; r < rows.length; r++) {
    const f = rows[r].f, i = rows[r].i;
    const delta = f.seoNew - f.seoOld;
    const tr = document.createElement('tr');
    tr.dataset.i = i;
    if (f.applied) tr.className = 'is-applied';

    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.i = i;
    cb.checked = f.selected;
    cb.className = 'tf-check';
    cb.setAttribute('aria-label', 'Select title ' + (r + 1) + ' for applying');
    tdCheck.appendChild(cb);

    const tdOld = document.createElement('td');
    tdOld.className = 'old';
    tdOld.textContent = f.oldTitle;

    const tdNew = document.createElement('td');
    tdNew.className = 'new';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = f.newTitle;
    input.dataset.i = i;
    input.className = 'tf-edit';
    input.maxLength = 100;
    input.setAttribute('aria-label', 'New title ' + (r + 1));
    const counter = document.createElement('div');
    counter.className = 'charcount';
    counter.textContent = f.newTitle.length + '/70';
    if (f.newTitle.length > 70) counter.classList.add('over');
    tdNew.appendChild(input);
    tdNew.appendChild(counter);

    const tdSeo = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'seo-wrap';
    const sNew = document.createElement('span');
    sNew.className = 'tag seo-' + band(f.seoNew);
    sNew.textContent = f.seoNew;
    sNew.title = 'SEO score ' + f.seoNew;
    wrap.appendChild(sNew);
    if (delta !== 0) {
      const d = document.createElement('span');
      d.className = 'delta ' + (delta > 0 ? 'up' : 'down');
      d.textContent = (delta > 0 ? '\u25B2 +' : '\u25BC ') + delta;
      wrap.appendChild(d);
    }
    tdSeo.appendChild(wrap);

    tr.appendChild(tdCheck);
    tr.appendChild(tdOld);
    tr.appendChild(tdNew);
    tr.appendChild(tdSeo);
    tbody.appendChild(tr);
  }
  updateSelectionCount();
}

function band(score) {
  if (score >= 75) return 'hi';
  if (score >= 55) return 'mid';
  return 'lo';
}

function selectableCount() {
  return forged.filter((f) => f.selected && f.newTitle !== f.oldTitle && !f.applied).length;
}

function updateSelectionCount() {
  const n = selectableCount();
  const changed = forged.filter((f) => f.newTitle !== f.oldTitle).length;
  const applied = forged.filter((f) => f.applied).length;
  let msg = '';
  if (forged.length) {
    msg = n + ' of ' + changed + ' changed title' + (changed === 1 ? '' : 's') + ' ready to apply';
    if (changed !== forged.length) msg += ' \u00b7 ' + (forged.length - changed) + ' unchanged';
    if (applied) msg += ' \u00b7 ' + applied + ' already applied';
  }
  setStatus('preview-count', msg);
  const applyBtn = $('btn-apply');
  if (applyBtn) {
    applyBtn.disabled = n === 0;
    applyBtn.textContent = n ? 'Apply ' + n + ' title' + (n === 1 ? '' : 's') : 'Apply selected';
  }
  const cost = $('apply-cost');
  if (cost) {
    cost.textContent = n
      ? 'Costs about ' + (n * (QUOTA_UPDATE + 1)).toLocaleString() + ' of your 10,000 daily YouTube API units'
      : '';
  }
}

/* Live edits + re-scoring */
document.addEventListener('input', function (e) {
  const i = e.target.dataset && e.target.dataset.i;
  if (i === undefined) return;
  if (e.target.type !== 'text') return;
  const f = forged[i];
  if (!f) return;
  f.newTitle = e.target.value;
  f.seoNew = seoScore(e.target.value);

  const cell = e.target.parentElement;
  const counter = cell.querySelector('.charcount');
  if (counter) {
    counter.textContent = e.target.value.length + '/70';
    counter.classList.toggle('over', e.target.value.length > 70);
  }
  const seoCell = cell.parentElement;
  const tag = seoCell.querySelector('.tag');
  if (tag) {
    tag.textContent = f.seoNew;
    tag.className = 'tag seo-' + band(f.seoNew);
    tag.title = 'SEO score ' + f.seoNew;
  }
  const wrap = seoCell.querySelector('.seo-wrap');
  if (wrap) {
    let dEl = wrap.querySelector('.delta');
    const d = f.seoNew - f.seoOld;
    if (d !== 0) {
      if (!dEl) {
        dEl = document.createElement('span');
        wrap.appendChild(dEl);
      }
      dEl.textContent = (d > 0 ? '\u25B2 +' : '\u25BC ') + d;
      dEl.className = 'delta ' + (d > 0 ? 'up' : 'down');
    } else if (dEl) {
      dEl.remove();
    }
  }
  updateSelectionCount();
});

document.addEventListener('change', function (e) {
  const i = e.target.dataset && e.target.dataset.i;
  if (i === undefined) return;
  if (e.target.type === 'checkbox') {
    const f = forged[i];
    if (!f) return;
    f.selected = e.target.checked;
    updateSelectionCount();
  }
});

/* Select all/none act on the rows the user can currently see, which is
   what the buttons sit next to. */
function setVisibleSelection(on) {
  const rows = visibleRows();
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r].i;
    forged[i].selected = on;
    const cb = document.querySelector('#preview-table input[type=checkbox][data-i="' + i + '"]');
    if (cb) cb.checked = on;
  }
  updateSelectionCount();
}

/* --- Apply renames --- */
async function applySelected() {
  const toApply = forged.filter((f) => f.selected && f.newTitle !== f.oldTitle && !f.applied);
  if (!toApply.length) { toast('Nothing selected to apply.', 'warn'); return; }

  const ok = confirm(
    'Apply ' + toApply.length + ' new title' + (toApply.length === 1 ? '' : 's') +
    ' to your live YouTube videos?\n\n' +
    'This uses about ' + (toApply.length * (QUOTA_UPDATE + 1)).toLocaleString() +
    ' of your 10,000 daily API units.\nYou can undo this afterwards.'
  );
  if (!ok) return;

  const btn = $('btn-apply');
  applyAbort = false;
  busy(btn, true, 'Applying...');
  show('btn-stop-apply');
  show('forge-progress');
  setBar('forge-bar', 0);
  setStatus('forge-status', 'Renaming videos...');

  let done = 0, failed = 0, lastError = '';
  let idx = 0;
  const workers = Array.from({ length: Math.min(APPLY_CONCURRENCY, toApply.length) }, async function () {
    while (idx < toApply.length && !applyAbort) {
      const f = toApply[idx++];
      try {
        await updateTitle(f.id, f.newTitle);
        f.applied = true;
        appliedHistory.push({ id: f.id, oldTitle: f.oldTitle, newTitle: f.newTitle });
        done++;
      } catch (e) {
        failed++;
        lastError = msgOf(e);
      }
      setBar('forge-bar', Math.round(((done + failed) / toApply.length) * 100));
      setStatus('forge-status', 'Renaming ' + (done + failed) + '/' + toApply.length + '...');
    }
  });
  await Promise.all(workers);

  hide('forge-progress');
  hide('btn-stop-apply');
  busy(btn, false);
  setStatus('forge-status', '');

  if (done) show('btn-undo');
  if (failed) {
    toast('Renamed ' + done + ' video' + (done === 1 ? '' : 's') + ' \u00b7 ' + failed +
      ' failed. ' + lastError, 'error');
  } else {
    toast('Renamed ' + done + ' video' + (done === 1 ? '' : 's') + '.', 'ok');
  }
  renderPreview();
}

function stopApply() {
  if (!applyAbort) {
    applyAbort = true;
    setStatus('forge-status', 'Stopping after the current request...');
  }
}

/* PUT only the fields YouTube needs. Sending the whole video object
   back (statistics, contentDetails) is malformed and wastes quota. */
async function updateTitle(id, title) {
  const item = { id: id, snippet: { title: String(title).slice(0, 100) } };
  const res = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) {
    const e = await res.json().catch(function () { return {}; });
    if (res.status === 401) {
      sessionStorage.removeItem('tf_token');
      throw new Error('Session expired - reconnect and retry.');
    }
    const reason = (e.error && e.error.errors && e.error.errors[0] && e.error.errors[0].reason) || '';
    if (reason.indexOf('quotaExceeded') !== -1) throw new Error('YouTube API quota exhausted for today.');
    if (reason.indexOf('titleTooLong') !== -1 || reason.indexOf('invalidTitle') !== -1) {
      throw new Error('YouTube rejected the title (over 100 chars or invalid characters).');
    }
    throw new Error((e.error && e.error.message) || 'update failed (' + res.status + ')');
  }
}

/* --- Undo: restore the previous titles --- */
async function undoApplied() {
  if (!appliedHistory.length) { toast('Nothing to undo.', 'warn'); return; }
  const total = appliedHistory.length;
  const ok = confirm('Revert ' + total + ' title' + (total === 1 ? '' : 's') +
    ' back to their originals?\n\nYour forged titles stay in the table so you can re-apply them.');
  if (!ok) return;

  const btn = $('btn-undo');
  busy(btn, true, 'Reverting...');
  show('forge-progress');
  setBar('forge-bar', 0);

  const pending = appliedHistory.slice();
  const reverted = [];
  let done = 0, failed = 0, lastError = '';
  let idx = 0;
  const workers = Array.from({ length: Math.min(APPLY_CONCURRENCY, pending.length) }, async function () {
    while (idx < pending.length) {
      const h = pending[idx++];
      try {
        await updateTitle(h.id, h.oldTitle);
        const f = forged.find(function (x) { return x.id === h.id; });
        if (f) {
          /* Keep newTitle as the forged title so it can be re-applied. */
          f.applied = false;
          f.selected = true;
          f.seoNew = seoScore(f.newTitle);
        }
        reverted.push(h);
        done++;
      } catch (e) {
        failed++;
        lastError = msgOf(e);
      }
      setBar('forge-bar', Math.round(((done + failed) / total) * 100));
    }
  });
  await Promise.all(workers);

  /* Only clear history for rows that actually reverted. */
  appliedHistory = appliedHistory.filter(function (h) {
    return reverted.indexOf(h) === -1;
  });

  hide('forge-progress');
  busy(btn, false);
  if (!appliedHistory.length) hide('btn-undo');
  renderPreview();
  if (failed) {
    toast('Reverted ' + done + ' \u00b7 ' + failed + ' failed. ' + lastError, 'error');
  } else {
    toast('Reverted ' + done + ' title' + (done === 1 ? '' : 's') +
      '. Your forged titles are still in the table.', 'ok');
  }
}

/* --- Export CSV --- */
function exportCSV() {
  if (!forged.length) { toast('Forge titles first.', 'warn'); return; }
  const rows = [['videoId', 'oldTitle', 'newTitle', 'seoOld', 'seoNew', 'selected', 'applied']];
  for (const f of forged) {
    rows.push([f.id, f.oldTitle, f.newTitle, f.seoOld, f.seoNew, f.selected ? 1 : 0, f.applied ? 1 : 0]);
  }
  const csv = '\ufeff' + rows.map(function (r) {
    return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'titleforge-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  toast('CSV exported (' + forged.length + ' rows).', 'ok');
}

/* --- Vault connection UI --- */
function connectVault() { window.location.href = getVault().authorizeUrl(); }

function disconnectVault() {
  getVault().logout();
  const btn = $('btn-vault');
  if (btn) { btn.textContent = 'Connect the Vault'; btn.classList.remove('btn-ghost'); btn.classList.add('btn-primary'); }
  setStatus('vault-status', '');
  hide('vault-status');
  paintVaultState();
  toast('Vault disconnected. AI key access revoked for this tab.', 'info');
}

function paintVaultState() {
  const on = getVault().isAuthenticated();
  const btn = $('btn-vault');
  if (btn) {
    btn.textContent = on ? 'Vault connected' : 'Connect the Vault';
    btn.classList.toggle('btn-primary', !on);
    btn.classList.toggle('btn-ghost', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  setStatus('vault-status', on ? '\u2713 AI key active \u00b7 server-side' : '');
  if (on) show('vault-status'); else hide('vault-status');
  const forge = $('btn-forge');
  if (forge) forge.disabled = !on;
  const fhint = $('forge-hint');
  if (fhint) {
    fhint.textContent = on
      ? 'The Vault proxies every request. Your AI key never reaches this page.'
      : 'Connect the Vault above to enable forging.';
  }
}

function syncStyle() { localStorage.setItem('tf_style', $('style').value); }

/* --- Wire up --- */
function wire() {
  $('btn-connect').addEventListener('click', startOAuth);
  $('btn-token').addEventListener('click', useManualToken);
  $('btn-disconnect').addEventListener('click', disconnect);
  $('btn-fetch').addEventListener('click', loadVideos);
  $('btn-stop-fetch').addEventListener('click', stopFetch);
  $('btn-forge').addEventListener('click', forgeTitles);
  $('btn-stop-forge').addEventListener('click', stopForge);
  $('btn-select-all').addEventListener('click', function () { setVisibleSelection(true); });
  $('btn-select-none').addEventListener('click', function () { setVisibleSelection(false); });
  $('btn-apply').addEventListener('click', applySelected);
  $('btn-stop-apply').addEventListener('click', stopApply);
  $('btn-undo').addEventListener('click', undoApplied);
  $('btn-export').addEventListener('click', exportCSV);
  $('btn-vault').addEventListener('click', function () {
    if (getVault().isAuthenticated()) disconnectVault(); else connectVault();
  });
  $('style').addEventListener('change', syncStyle);
  $('search').addEventListener('input', renderPreview);
  $('only-changed').addEventListener('change', renderPreview);
  $('token-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') useManualToken();
  });
  $('search').addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && e.target.value) { e.target.value = ''; renderPreview(); }
  });
}

/* --- Init --- */
wire();
paintRail('connect');
paintVaultState();

const savedStyle = localStorage.getItem('tf_style');
if (savedStyle) $('style').value = savedStyle;

/* Vault redirect: exchange the one-time code for an in-memory token. */
const dvCode = DevVaultClient.codeFromLocation();
if (dvCode) {
  getVault().exchangeCode(dvCode, DevVaultClient.redirectUriFromLocation())
    .then(function () { paintVaultState(); toast('Vault connected - AI key is live.', 'ok'); })
    .catch(function (e) { paintVaultState(); toast('Vault connection failed: ' + msgOf(e), 'error'); });
}

/* Google OAuth redirect - run connected() exactly once. */
if (handleRedirect()) {
  connected();
} else {
  const saved = sessionStorage.getItem('tf_token');
  if (saved) { token = saved; connected(); }
}
