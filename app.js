/* TitleForge — core app logic (skeleton)
 * Connect -> Fetch -> Forge -> Apply
 * YouTube Data API v3 + pluggable AI engine.
 */
const $ = (id) => document.getElementById(id);

// --- State ---
let token = '';
let videos = [];          // fetched videos
let forged = [];          // {id, oldTitle, newTitle, seo, selected}

// --- Config (filled in the build phase) ---
const CONFIG = {
  CLIENT_ID: '',          // OAuth client id (Web app)
  REDIRECT_URI: window.location.origin + window.location.pathname,
  SCOPES: 'https://www.googleapis.com/auth/youtube.force-ssl',
  DEFAULT_AI: '',         // free default AI endpoint/key
};

// --- UI helpers ---
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function setStatus(id, msg) { $(id).textContent = msg; }

// --- OAuth (Google) ---
function startOAuth() {
  const params = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    response_type: 'token',
    scope: CONFIG.SCOPES,
    include_granted_scopes: 'true',
  });
  window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

// Catch token from redirect (#access_token=...)
function handleRedirect() {
  const h = new URLSearchParams(window.location.hash.substring(1));
  const t = h.get('access_token');
  if (t) {
    token = t;
    sessionStorage.setItem('tf_token', t);
    window.location.hash = '';
    connected();
  }
}

function useManualToken() {
  const t = $('token-input').value.trim();
  if (t) { token = t; sessionStorage.setItem('tf_token', t); connected(); }
}

function connected() {
  hide('step-connect');
  show('step-fetch');
  setStatus('connected-ok', '✓ Connected');
}

// --- YouTube API ---
async function ytFetch(path) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/' + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || 'YouTube API error ' + res.status);
  }
  return res.json();
}

async function loadVideos() {
  show('fetch-progress');
  setStatus('fetch-status', 'Loading videos...');
  videos = [];
  let page = '';
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
  } while (page);
  hide('fetch-progress');
  setStatus('fetch-status', 'Loaded ' + videos.length + ' videos');
  hide('step-fetch');
  show('step-ai');
}

// --- AI Engine (pluggable) ---
async function forgeTitles() {
  const provider = $('provider').value;
  const apiKey = $('apikey').value.trim();
  const style = $('style').value;
  show('forge-progress');
  forged = [];
  const total = videos.length;
  for (let i = 0; i < total; i++) {
    const v = videos[i];
    let newTitle = '';
    try {
      newTitle = await generateTitle(v, provider, apiKey, style);
    } catch (e) {
      newTitle = v.title; // fallback: keep original
    }
    forged.push({
      id: v.id,
      oldTitle: v.title,
      newTitle: newTitle || v.title,
      seo: seoScore(newTitle),
      selected: true,
    });
    $('forge-bar').style.width = Math.round(((i + 1) / total) * 100) + '%';
  }
  hide('forge-progress');
  renderPreview();
  hide('step-ai');
  show('step-preview');
}

// Single-title generation — pluggable per provider
async function generateTitle(video, provider, apiKey, style) {
  const prompt = buildPrompt(video, style);
  if (provider === 'default') {
    return callDefaultAI(prompt, CONFIG.DEFAULT_AI);
  }
  if (provider === 'openai') {
    return callOpenAI(prompt, apiKey);
  }
  if (provider === 'claude') {
    return callClaude(prompt, apiKey);
  }
  if (provider === 'gemini') {
    return callGemini(prompt, apiKey);
  }
  return video.title;
}

function buildPrompt(video, style) {
  return [
    'You are a YouTube title expert. Rewrite this video title to maximize clicks (CTR) while staying honest.',
    'Return ONLY the new title, max 90 characters, English.',
    'Style: ' + style,
    'Old title: ' + video.title,
    'Description: ' + (video.description || '').slice(0, 300),
    'Views: ' + video.views + ', Likes: ' + video.likes,
  ].join('\n');
}

// --- AI provider callbacks (implemented in build phase) ---
async function callDefaultAI(prompt, endpoint) {
  // Free default model — fill in during build phase.
  throw new Error('Default AI not configured yet');
}
async function callOpenAI(prompt, key) { throw new Error('Not implemented'); }
async function callClaude(prompt, key) { throw new Error('Not implemented'); }
async function callGemini(prompt, key) { throw new Error('Not implemented'); }

// --- SEO scoring (simple heuristic) ---
function seoScore(title) {
  let s = 40;
  const len = title.length;
  if (len >= 20 && len <= 70) s += 20;      // good length
  if (len > 70) s -= 10;
  if (/\b(how|why|best|top|vs|guide|tutorial|tips|tricks|secret|free)\b/i.test(title)) s += 15;
  if (/[0-9]/.test(title)) s += 10;          // numbers
  if (/[!?]/.test(title)) s += 5;            // punch
  if (/[A-Z]/.test(title)) s += 5;           // proper case
  return Math.max(0, Math.min(99, s));
}

// --- Preview table ---
function renderPreview() {
  const tbody = document.querySelector('#preview-table tbody');
  tbody.innerHTML = '';
  forged.forEach((f, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="checkbox" data-i="' + i + '" ' + (f.selected ? 'checked' : '') + '></td>' +
      '<td class="old">' + esc(f.oldTitle) + '</td>' +
      '<td class="new"><input type="text" value="' + esc(f.newTitle) + '" data-i="' + i + '" style="width:100%;min-width:200px"></td>' +
      '<td><span class="tag">' + f.seo + '</span></td>';
    tbody.appendChild(tr);
  });
  $('preview-count').textContent = forged.length + ' videos ready';
}

document.addEventListener('change', (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  if (e.target.type === 'checkbox') forged[i].selected = e.target.checked;
  else forged[i].newTitle = e.target.value;
});

function selectAll() {
  forged.forEach((f) => (f.selected = true));
  document.querySelectorAll('#preview-table input[type=checkbox]').forEach((c) => (c.checked = true));
}

// --- Apply renames ---
async function applySelected() {
  const toApply = forged.filter((f) => f.selected && f.newTitle !== f.oldTitle);
  let done = 0;
  show('forge-progress');
  for (const f of toApply) {
    try {
      await updateTitle(f.id, f.newTitle);
      done++;
    } catch (e) { /* skip */ }
    $('forge-bar').style.width = Math.round((done / toApply.length) * 100) + '%';
  }
  hide('forge-progress');
  alert('Renamed ' + done + ' of ' + toApply.length + ' videos');
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
  if (!res.ok) throw new Error('update failed');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '"');
}

// --- Wire up ---
$('btn-connect').addEventListener('click', startOAuth);
$('btn-token').addEventListener('click', useManualToken);
$('btn-fetch').addEventListener('click', loadVideos);
$('btn-forge').addEventListener('click', forgeTitles);
$('btn-select-all').addEventListener('click', selectAll);
$('btn-apply').addEventListener('click', applySelected);

// Restore token + handle redirect on load
handleRedirect();
const saved = sessionStorage.getItem('tf_token');
if (saved) { token = saved; connected(); }
