#!/usr/bin/env node
// ============================================================
// TitleForge — smoke check.
// ------------------------------------------------------------
// The build validates structure. THIS validates that pages
// actually show content WITHOUT JavaScript.
//
// Why this file exists: commit e372cc7 fixed an "invisible hero".
// index.html shipped a page that rendered NOTHING because the
// reveal script had been deleted, and 200 lines of code elsewhere
// did not notice. Static-HTML visibility is the exact regression,
// so it gets its own check.
//
// Zero dependencies. Reads files from disk. No network required.
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = dirname(new URL(import.meta.url).pathname);
let pass = 0, fail = 0;

const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const no = (m) => { fail++; console.log('  ✗ ' + m); };

const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

function checkPage(file, isShim = false) {
  console.log(`\n${file}`);
  const p = join(ROOT, file);
  if (!existsSync(p)) { no(`${file} does not exist`); return; }
  const html = readFileSync(p, 'utf8');

  // Where does the first executable script start?
  const scriptAt = html.search(/<script\b/i);
  const preScript = scriptAt === -1 ? html : html.slice(0, scriptAt);

  // 1. a content landmark (a redirect shim has none, and that is correct)
  if (isShim) {
    console.log('  · redirect shim: no <main> expected');
  } else if (/<main\b/i.test(html) || /role\s*=\s*["']main["']/i.test(html)) ok('has a <main> content landmark');
  else no('no <main> / role=main landmark');

  // 2. The hero headline must exist in the STATIC html.
  //    Checks the <h1> if present; if the page has none, it falls back
  //    to a known hero string so that DELETING the h1 cannot make the
  //    check silently pass.
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const FALLBACK_HERO = {
    'index.html': 'Forge perfect YouTube titles',
    'app.html': 'Connect your channel',
  };
  if (h1) {
    const t = stripTags(h1);
    if (!t) no('<h1> is present but empty — the hero would render blank');
    else if (preScript.includes(h1)) ok(`hero text is in static HTML, not script-injected: "${t.slice(0, 60)}"`);
    else no(`hero text is NOT in the static HTML before <script> — the e372cc7 failure mode: "${t.slice(0, 60)}"`);
  } else if (!isShim) {
    const needle = FALLBACK_HERO[file];
    if (needle) {
      if (preScript.includes(needle)) ok(`no <h1>, but the expected hero copy "${needle}" is still in the static HTML`);
      else no(`no <h1> AND the expected hero copy "${needle}" is missing from the static HTML — this is the e372cc7 failure mode`);
    } else {
      no('no <h1> and no known hero string to fall back on — review this page');
    }
  } else {
    console.log('  · no <h1> (redirect shim — expected)');
  }

  // 3. at least one 20+ char visible text run in the body BEFORE any script
  const bodyStart = html.search(/<body\b/i);
  const staticBody = bodyStart === -1 ? preScript : html.slice(bodyStart, scriptAt === -1 ? undefined : scriptAt);
  const text = stripTags(staticBody);
  if (isShim) {
    console.log('  · redirect shim: empty <body> is by design (GitHub Pages SPA fallback)');
    if (/<script\b/i.test(html)) ok('shim performs its redirect from an inline script');
    else no('shim has no script and no content — it would render a blank page');
  } else if (text.length >= 20) ok(`static body has ${text.length} chars of visible text before any <script>`);
  else no(`static body has only ${text.length} chars of visible text before any <script> — page needs JS to show anything`);

  // 4. The FIRST content block must not be hidden pending a script.
  //    Later progressive-disclosure panels (class "hidden", revealed as
  //    the user advances through connect -> fetch -> forge -> apply) are
  //    correct design, not the e372cc7 failure. Only the first block counts.
  const firstBlock = (staticBody.match(/<(section|div|main)[^>]*>/i) || [])[0] || '';
  const hidesFirst = /\b(op-0|opacity:\s*0|invisible|is-loading)\b/i.test(firstBlock);
  if (!hidesFirst) ok('first content block is not hidden pending a script');
  else no(`first content block is hidden in the static HTML (${firstBlock.slice(0, 60)}) — content depends on a script to appear`);

  // 5. Progressive disclosure is legitimate, but it must actually be WIRED:
  //    a panel that starts hidden must be un-hidden by the script. Counting
  //    add() as well as remove() would make this check unfailable, because
  //    every hide() call would satisfy it — so removes are counted alone and
  //    must outnumber adds.
  const hiddenPanels = (html.match(/class="[^"]*\bhidden\b[^"]*"/gi) || []).length;
  if (hiddenPanels) {
    const inline = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
    const appjs = existsSync(join(ROOT, 'app.js')) ? readFileSync(join(ROOT, 'app.js'), 'utf8') : '';
    const code = inline + '\n' + appjs;
    const removes = (code.match(/classList\.remove\(\s*['"]hidden['"]\s*\)/g) || []).length
      + (code.match(/\.className\s*=[^;]*?replace\([^)]*hidden[^)]*['"]['"]/g) || []).length;
    const adds = (code.match(/classList\.add\(\s*['"]hidden['"]\s*\)/g) || []).length;
    if (removes > 0 && removes >= adds) {
      ok(`${hiddenPanels} hidden panel(s); ${removes} reveal(s) vs ${adds} hide(s) — progressive disclosure is wired`);
    } else {
      no(`${hiddenPanels} panel(s) start hidden, but reveals(${removes}) do not outnumber hides(${adds}) — some content is unreachable`);
    }
  }

  // 5. every <section> referenced by the skip link must exist
  for (const m of html.matchAll(/class\s*=\s*["']skip["'][^>]*href\s*=\s*["']#([^"']+)["']/gi)) {
    const id = m[1];
    if (new RegExp(`id\\s*=\\s*["']${id}["']`).test(html)) ok(`skip link target #${id} exists`);
    else no(`skip link points to #${id} but no such id exists`);
  }
}

console.log('TitleForge smoke check (no-JS content visibility)');
console.log('================================================');

for (const f of ['index.html', 'app.html']) checkPage(f);
checkPage('404.html', true);

console.log(`\n================================================`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);