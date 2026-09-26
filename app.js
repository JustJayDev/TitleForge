/* =============================================================
 * TitleForge — core app logic
 * Connect -> Fetch -> Forge -> Review -> Apply (-> Undo)
 * YouTube Data API v3 + pluggable AI engine.
 * ============================================================= */

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

/* --- State --- */
let token = '';
let videos = [];            // fetched videos
let forged = [];            // {id, oldTitle, newTitle, seoOld, seoNew, selected, applied}
let appliedHistory = [];    // [{id, oldTitle}] for undo
let connectedChannel = null;
let forgeAbort = false;

/* --- Config ----------------------------------------------------
 * CLIENT_ID: your Google OAuth Web-app client ID.
 *   Console -> APIs & Services -> Credentials -> Create OAuth client ID (Web app)
 *   Authorised redirect URI: the URL of this app.html page.
 * DEFAULT_AI: the free model every user gets out of the box.
 *   OpenAI-compatible gateway. Drop a key in DEFAULT_AI.key to enable it.
 * -------------------------------------------------------------- */
const CONFIG = {
  // Google OAuth Web-app client ID (implicit flow — no secret needed, and never
  // put a secret in client-side code). Console: APIs & Services -> Credentials.
  CLIENT_ID: '135469633703-c95kvlba4i5qiuibnnpn06g9ns7aamfe.apps.googleusercontent.com',
  REDIRECT_URI: window.location.origin + window.location.pathname,
  SCOPES: 'https://www.googleapis.com/auth/youtube.force-ssl',
  // Free default model — OpenAI-compatible gateway. Users never need a key.
  DEFAULT_AI: {
    baseUrl: 'https://inference.dahl.global/v1',
    key: 'PASTE_FREE_DEFAULT_KEY', // set at deploy time; see README
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  },
};

const MODELS = {
  openai: 'gpt-4o-mini',
  claude: 'claude-3-5-haiku-latest',
  gemini: 'gemini-1.5-flash',
};

/* --- UI helpers --- */
function show(id) { $(id)?.classList.remove('hidden'); }
function hide(id) { $(id)?.classList.add('hidden'); }
function setStatus(id, msg) { const el = $(id); if (el) el.textContent = msg; }

/* --- Toast notifications --- */
function toast(msg, type = 'info') {
  const box = $('toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 350);
  }, 4200);
}

/* --- OAuth (Google, implicit flow) --- */
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

/* Catch token from redirect (#access_token=...) */
function handleRedirect() {
  const h = new URLSearchParams(window.location.hash.substring(1));
  const t = h.get('access_token');
  if (t) {
    token = t;
    sessionStorage.setItem('tf_token', t);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    connected();
  }
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
  show('step-fetch');
  setStatus('connected-ok', '✓ Connected');
  show('connected-ok');
  // Resolve channel identity for a nicer UX (non-fatal)
  try {
    const data = await ytFetch('channels?part=snippet&mine=true');
    const ch = data.items?.[0];
    if (ch) {
      connectedChannel = { name: ch.snippet.title, thumb: ch.snippet.thumbnails?.default?.url };
      setStatus('connected-ok', '✓ ' + connectedChannel.name);
    }
  } catch (e) { /* token still usable */ }
  show('step-fetch-hint');
}

function disconnect() {
  token = '';
  sessionStorage.removeItem('tf_token');
  videos = []; forged = []; appliedHistory = []; connectedChannel = null;
  hide('step-fetch'); hide('step-ai'); hide('step-preview');
  show('step-connect');
  setStatus('connected-ok', '');
  toast('Disconnected. Token cleared from this tab.', 'info');
}

/* --- YouTube API --- */
async function ytFetch(path) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/' + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (res.status === 401) {
    sessionStorage.removeItem('tf_token');
    throw new Error('Your Google session expired. Please reconnect.');
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || 'YouTube API error ' + res.status);
  }
  return res.json();
}

async function loadVideos() {
  show('fetch-progress');
  setBar('fetch-bar', 0);
  setStatus('fetch-status', 'Loading videos…');
  videos = [];
  let page = '';
  let pages = 0;
  try {
    do {
      const data = await ytFetch(
        'videos?part=snippet,statistics,contentDetails&mine=true&maxResults=50' +
        (page ? '&pageToken=' + page : '')
      );
      for (const v of data.items || []) {
        videos.push({
          id: v.id,
          title: v.snippet.title,
          description: v.snippet.description,
          views: +(v.statistics?.viewCount || 0),
          likes: +(v.statistics?.likeCount || 0),
          comments: +(v.statistics?.commentCount || 0),
          duration: v.contentDetails?.duration || '',
          published: v.snippet.publishedAt,
        });
      }
      page = data.nextPageToken || '';
      pages++;
      setBar('fetch-bar', Math.min(95, pages * 12));
      setStatus('fetch-status', 'Loaded ' + videos.length + ' videos…');
    } while (page);
  } catch (e) {
    hide('fetch-progress');
    setStatus('fetch-status', '');
    toast(e.message, 'error');
    return;
  }
  hide('fetch-progress');
  if (!videos.length) {
    setStatus('fetch-status', 'No videos found on this channel.');
    toast('No videos found for this account.', 'warn');
    return;
  }
  setStatus('fetch-status', 'Loaded ' + videos.length + ' videos');
  hide('step-fetch');
  show('step-ai');
  setStatus('ai-count', videos.length + ' videos queued');
}

/* --- Progress bar --- */
function setBar(id, pct) {
  const bar = $(id);
  if (bar) bar.style.width = pct + '%';
}

/* --- AI Engine (pluggable, concurrent) --- */
async function forgeTitles() {
  const provider = $('provider').value;
  const apiKey = $('apikey').value.trim();
  const style = $('style').value;

  if (provider === 'default' && (!CONFIG.DEFAULT_AI.key || CONFIG.DEFAULT_AI.key.startsWith('PASTE_'))) {
    toast('Free default model is not configured yet. Add DEFAULT_AI.key in app.js, or use your own key.', 'warn');
    return;
  }
  if (provider !== 'default' && !apiKey) {
    toast('Paste your ' + provider + ' API key first.', 'warn');
    return;
  }

  forgeAbort = false;
  show('forge-progress');
  setBar('forge-bar', 0);
  setStatus('forge-status', 'Forging titles…');
  forged = videos.map((v) => ({
    id: v.id, oldTitle: v.title, newTitle: v.title,
    seoOld: seoScore(v.title), seoNew: seoScore(v.title),
    selected: true, applied: false,
  }));

  let done = 0;
  const total = forged.length;
  const queue = forged.map((_, i) => i);

  // Run N requests in parallel for a big speedup
  const CONCURRENCY = Math.min(6, total);
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !forgeAbort) {
      const i = queue.shift();
      const v = videos[i];
      try {
        const t = await generateTitle(v, provider, apiKey, style);
        forged[i].newTitle = cleanTitle(t) || v.title;
        forged[i].seoNew = seoScore(forged[i].newTitle);
      } catch (e) {
        forged[i].newTitle = v.title;      // fallback: keep original
        forged[i].seoNew = forged[i].seoOld;
      }
      done++;
      setBar('forge-bar', Math.round((done / total) * 100));
      setStatus('forge-status', 'Forging ' + done + '/' + total + '…');
    }
  });
  await Promise.all(workers);

  hide('forge-progress');
  if (forgeAbort) { toast('Forge stopped.', 'warn'); return; }

  renderPreview();
  hide('step-ai');
  show('step-preview');
  const lift = avgLift();
  if (lift > 0) {
    setStatus('preview-seo', '▲ avg SEO ' + Math.round(avgSeo(forged.map((f) => f.seoOld))) +
      ' → ' + Math.round(avgSeo(forged.map((f) => f.seoNew))) + ' (+' + lift + ')');
  } else {
    setStatus('preview-seo', '');
  }
  show('preview-seo');
  const changed = forged.filter((f) => f.newTitle !== f.oldTitle).length;
  toast('Forged ' + changed + ' titles. Review before applying.', 'ok');
}

function stopForge() { forgeAbort = true; }

/* Average SEO lift across changed titles */
function avgSeo(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }
function avgLift() {
  const changed = forged.filter((f) => f.newTitle !== f.oldTitle);
  if (!changed.length) return 0;
  return Math.round(avgSeo(changed.map((f) => f.seoNew)) - avgSeo(changed.map((f) => f.seoOld)));
}

/* Single-title generation — pluggable per provider */
async function generateTitle(video, provider, apiKey, style) {
  const prompt = buildPrompt(video, style);
  switch (provider) {
    case 'default': return callDefaultAI(prompt);
    case 'openai':  return callOpenAI(prompt, apiKey);
    case 'claude':  return callClaude(prompt, apiKey);
    case 'gemini':  return callGemini(prompt, apiKey);
    default:        return video.title;
  }
}

function buildPrompt(video, style) {
  return [
    'You are a world-class YouTube title strategist. Rewrite this video title to maximize click-through rate while staying truthful to the content. Never invent facts, names, or claims that are not in the input.',
    'Reply with the raw title text only — no quotes, no labels, no meta commentary, no character counts, no notes. One single line.',
    'Maximum 70 characters. Title case or sentence case — no ALL CAPS. Do not end with a period.',
    'Style: ' + style,
    'Current title: ' + video.title,
    'Description: ' + (video.description || '').slice(0, 400),
    'Performance: ' + video.views + ' views, ' + video.likes + ' likes, ' + video.comments + ' comments',
  ].join('\n');
}

/* --- Provider: free default (OpenAI-compatible gateway) --- */
async function callDefaultAI(prompt) {
  return openAICompatible(CONFIG.DEFAULT_AI.baseUrl, CONFIG.DEFAULT_AI.key, CONFIG.DEFAULT_AI.model, prompt);
}

/* --- Provider: OpenAI --- */
async function callOpenAI(prompt, key) {
  return openAICompatible('https://api.openai.com/v1', key, MODELS.openai, prompt);
}

/* Shared OpenAI-format chat completion */
async function openAICompatible(base, key, model, prompt) {
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You write high-CTR YouTube titles. Reply with only the title.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 120,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || 'AI error ' + res.status);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/* --- Provider: Claude (Anthropic) --- */
async function callClaude(prompt, key) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODELS.claude,
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || 'Claude error ' + res.status);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

/* --- Provider: Gemini --- */
async function callGemini(prompt, key) {
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + MODELS.gemini + ':generateContent?key=' + key,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 120 },
      }),
    }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || 'Gemini error ' + res.status);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/* Normalise model output into a single clean title line */
function cleanTitle(raw) {
  let t = String(raw || '');
  // Strip invisible / zero-width / fullwidth-space padding some models emit
  t = t.replace(/[\u00A0\u1680\u180E\u2000-\u200F\u202F\u205F\u3000\u3164\uFFA0\uFEFF]/g, ' ');
  t = t.trim();
  t = t.replace(/^["'`“”]+|["'`“”]+$/g, '');   // strip wrapping quotes
  t = t.split('\n')[0];                          // first line only
  t = t.replace(/^(title|new title|suggested title)\s*[:\-]?\s*/i, '');
  // Drop trailing meta commentary like "(55 chars)"
  t = t.replace(/\s*\([\d\s]*(chars?|characters?|title)\b[^)]*\)\s*$/i, '');
  t = t.replace(/\s*\[\d+\s*chars?\]\s*$/i, '');
  // Some models emit hashtag soup / multiple titles joined by | — keep the first
  t = t.split(/[|｜]/)[0];
  // Strip hashtag runs entirely (they never belong in a title)
  t = t.replace(/#[\w]+/g, '').replace(/\s{2,}/g, ' ');
  // Remove leading <think> blocks / reasoning leakage
  t = t.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  if (!t.trim()) t = String(raw || '');          // never return empty
  t = t.trim();
  if (t.length > 100) t = t.slice(0, 100).trim();
  return t;
}

/* --- SEO scoring (heuristic) --- */
function seoScore(title) {
  let s = 40;
  const len = title.length;
  if (len >= 20 && len <= 70) s += 20;      // sweet spot
  if (len > 70) s -= 10;
  if (len < 12) s -= 10;
  if (/\b(how|why|best|top|vs|guide|tutorial|tips|tricks|secret|free|easy|new|ultimate)\b/i.test(title)) s += 15;
  if (/[0-9]/.test(title)) s += 10;          // numbers
  if (/[!?]/.test(title)) s += 5;            // punch
  if (/[A-Z]/.test(title)) s += 5;           // proper case
  if (title === title.toUpperCase() && len > 5) s -= 10;  // no shouting
  return Math.max(0, Math.min(99, s));
}

/* --- Preview table --- */
function renderPreview() {
  const tbody = document.querySelector('#preview-table tbody');
  tbody.innerHTML = '';
  const q = ($('search')?.value || '').toLowerCase();
  const onlyChanged = $('only-changed')?.checked;

  forged.forEach((f, i) => {
    if (q && !(f.oldTitle + ' ' + f.newTitle).toLowerCase().includes(q)) return;
    if (onlyChanged && f.newTitle === f.oldTitle) return;

    const tr = document.createElement('tr');
    const delta = f.seoNew - f.seoOld;

    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.i = i;
    cb.checked = f.selected;
    cb.classList.add('tf-check');
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
    input.classList.add('tf-edit');
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
    wrap.appendChild(sNew);
    if (delta !== 0) {
      const d = document.createElement('span');
      d.className = 'delta ' + (delta > 0 ? 'up' : 'down');
      d.textContent = (delta > 0 ? '▲ +' : '▼ ') + delta;
      wrap.appendChild(d);
    }
    tdSeo.appendChild(wrap);

    tr.appendChild(tdCheck);
    tr.appendChild(tdOld);
    tr.appendChild(tdNew);
    tr.appendChild(tdSeo);
    tbody.appendChild(tr);
  });

  updateSelectionCount();
}

function band(score) {
  if (score >= 75) return 'hi';
  if (score >= 55) return 'mid';
  return 'lo';
}

function updateSelectionCount() {
  const n = forged.filter((f) => f.selected && f.newTitle !== f.oldTitle).length;
  setStatus('preview-count', n + ' of ' + forged.length + ' titles ready to apply');
  const applyBtn = $('btn-apply');
  if (applyBtn) applyBtn.disabled = n === 0;
}

/* Live edits + re-scoring */
document.addEventListener('input', (e) => {
  const i = e.target.dataset?.i;
  if (i === undefined) return;
  if (e.target.type === 'text') {
    forged[i].newTitle = e.target.value;
    forged[i].seoNew = seoScore(e.target.value);
    const counter = e.target.parentElement.querySelector('.charcount');
    if (counter) {
      counter.textContent = e.target.value.length + '/70';
      counter.classList.toggle('over', e.target.value.length > 70);
    }
    const tag = e.target.parentElement.parentElement.querySelector('.tag');
    if (tag) { tag.textContent = forged[i].seoNew; tag.className = 'tag seo-' + band(forged[i].seoNew); }
    updateSelectionCount();
  }
});

document.addEventListener('change', (e) => {
  const i = e.target.dataset?.i;
  if (i === undefined) return;
  if (e.target.type === 'checkbox') {
    forged[i].selected = e.target.checked;
    updateSelectionCount();
  }
});

function selectAll() {
  forged.forEach((f) => (f.selected = true));
  $$('#preview-table input[type=checkbox]').forEach((c) => (c.checked = true));
  updateSelectionCount();
}
function selectNone() {
  forged.forEach((f) => (f.selected = false));
  $$('#preview-table input[type=checkbox]').forEach((c) => (c.checked = false));
  updateSelectionCount();
}

/* --- Apply renames --- */
async function applySelected() {
  const toApply = forged.filter((f) => f.selected && f.newTitle !== f.oldTitle && !f.applied);
  if (!toApply.length) { toast('Nothing selected to apply.', 'warn'); return; }

  const ok = confirm('Apply ' + toApply.length + ' new titles to your live YouTube videos?\nYou can undo this afterwards.');
  if (!ok) return;

  show('forge-progress');
  setBar('forge-bar', 0);
  let done = 0, failed = 0;
  for (const f of toApply) {
    try {
      await updateTitle(f.id, f.newTitle);
      f.applied = true;
      appliedHistory.push({ id: f.id, oldTitle: f.oldTitle });
      done++;
    } catch (e) {
      failed++;
    }
    setBar('forge-bar', Math.round(((done + failed) / toApply.length) * 100));
  }
  hide('forge-progress');

  if (done) show('btn-undo');
  toast('Renamed ' + done + ' videos' + (failed ? ' · ' + failed + ' failed' : '') + '.', failed ? 'warn' : 'ok');
  updateSelectionCount();
  renderPreview();
}

async function updateTitle(id, title) {
  const data = await ytFetch('videos?part=snippet&id=' + id);
  const item = data.items?.[0];
  if (!item) throw new Error('not found');
  item.snippet.title = title;
  const res = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || 'update failed');
  }
}

/* --- Undo: restore the previous titles --- */
async function undoApplied() {
  if (!appliedHistory.length) { toast('Nothing to undo.', 'warn'); return; }
  show('forge-progress');
  setBar('forge-bar', 0);
  let done = 0;
  const total = appliedHistory.length;
  for (const h of appliedHistory) {
    try {
      await updateTitle(h.id, h.oldTitle);
      const f = forged.find((x) => x.id === h.id);
      if (f) { f.newTitle = f.oldTitle; f.seoNew = f.seoOld; f.applied = false; }
      done++;
    } catch (e) { /* skip */ }
    setBar('forge-bar', Math.round((done / total) * 100));
  }
  appliedHistory = [];
  hide('forge-progress');
  hide('btn-undo');
  renderPreview();
  toast('Reverted ' + done + ' titles to their originals.', 'ok');
}

/* --- Export CSV of the forge results --- */
function exportCSV() {
  if (!forged.length) { toast('Forge titles first.', 'warn'); return; }
  const rows = [['videoId', 'oldTitle', 'newTitle', 'seoOld', 'seoNew', 'selected']];
  for (const f of forged) {
    rows.push([f.id, f.oldTitle, f.newTitle, f.seoOld, f.seoNew, f.selected ? 1 : 0]);
  }
  const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'titleforge-' + Date.now() + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* --- Provider UI: show/hide key field, remember it --- */
function syncProviderUI() {
  const p = $('provider').value;
  const keyWrap = $('apikey-wrap');
  keyWrap.classList.toggle('hidden', p === 'default');
  const hint = $('provider-hint');
  if (p === 'default') hint.textContent = 'Free model · no key needed';
  else if (p === 'openai') hint.textContent = 'platform.openai.com → API keys';
  else if (p === 'claude') hint.textContent = 'console.anthropic.com → API keys';
  else hint.textContent = 'aistudio.google.com → API key';
  localStorage.setItem('tf_provider', p);
}

/* --- Wire up --- */
function wire() {
  $('btn-connect').addEventListener('click', startOAuth);
  $('btn-token').addEventListener('click', useManualToken);
  $('btn-disconnect').addEventListener('click', disconnect);
  $('btn-fetch').addEventListener('click', loadVideos);
  $('btn-forge').addEventListener('click', forgeTitles);
  $('btn-stop-forge').addEventListener('click', stopForge);
  $('btn-select-all').addEventListener('click', selectAll);
  $('btn-select-none').addEventListener('click', selectNone);
  $('btn-apply').addEventListener('click', applySelected);
  $('btn-undo').addEventListener('click', undoApplied);
  $('btn-export').addEventListener('click', exportCSV);
  $('provider').addEventListener('change', syncProviderUI);
  $('search').addEventListener('input', renderPreview);
  $('only-changed').addEventListener('change', renderPreview);
  $('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') useManualToken(); });
}

/* --- Init --- */
wire();
syncProviderUI();
const savedProvider = localStorage.getItem('tf_provider');
if (savedProvider) $('provider').value = savedProvider, syncProviderUI();
handleRedirect();
const saved = sessionStorage.getItem('tf_token');
if (saved) { token = saved; connected(); }
