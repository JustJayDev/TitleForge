#!/usr/bin/env node
// ============================================================
// TitleForge — zero-dependency build check.
// ------------------------------------------------------------
// No bundler, no framework, no network. This does NOT emit a
// bundle; it HARDENS the fact that TitleForge ships raw files.
// If any of this fails, the site is not shippable.
//
// It exists because commit e372cc7 had to fix an "invisible
// hero": index.html rendered nothing and nothing caught it.
// ============================================================

import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = dirname(new URL(import.meta.url).pathname);
const errors = [];
const warnings = [];

const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/* ---------- 1. syntax check every shipped script ---------- */
// app.js/vault.js are ES modules, so they are checked as .mjs.
// A plain `node --check app.js` would report a false failure.
function checkSyntax(file) {
  const tmp = join(mkdtempSync(join(tmpdir(), 'tf-')), 'check.mjs');
  try {
    writeFileSync(tmp, readFileSync(join(ROOT, file)));
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    fail(`  ${file} failed node --check:\n${String(e.stderr || e).trim().split('\n').slice(0, 4).map(l => '      ' + l).join('\n')}`);
  } finally {
    rmSync(dirname(tmp), { recursive: true, force: true });
  }
}

for (const f of ['app.js', 'vault.js']) {
  if (existsSync(join(ROOT, f))) checkSyntax(f);
  else fail(`  ${f} is missing`);
}

// inline <script> blocks must also parse
for (const html of ['index.html', 'app.html', '404.html']) {
  const p = join(ROOT, html);
  if (!existsSync(p)) { fail(`  ${html} is missing`); continue; }
  const src = readFileSync(p, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  const dir = mkdtempSync(join(tmpdir(), 'tf-'));
  while ((m = re.exec(src))) {
    const code = m[1].trim();
    if (!code) continue;
    n++;
    const tmp = join(dir, `inline-${n}.mjs`);
    try {
      writeFileSync(tmp, code);
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
      fail(`  ${html} inline script #${n} failed node --check:\n      ${String(e.stderr || '').split('\n').filter(l => l.includes('Error') || l.includes('^')).slice(0, 2).join('\n      ')}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/* ---------- 2. every shipped file must be non-empty ----------
   Same failure class that hit DevVault's tokens.css. An empty
   stylesheet still "builds"; it just renders nothing. */
const SHIPPED = [
  'index.html', 'app.html', '404.html',
  'app.js', 'vault.js',
  'style.css', 'app.css', 'premium.css',
];
for (const f of SHIPPED) {
  const p = join(ROOT, f);
  if (!existsSync(p)) { fail(`  ${f} is missing`); continue; }
  const size = readFileSync(p).length;
  if (size === 0) fail(`  ${f} is EMPTY — refusing to ship a blank asset`);
}

// ---------- 3. every referenced asset must exist on disk ----------
function checkRefs(html) {
  const p = join(ROOT, html);
  if (!existsSync(p)) return;
  const src = readFileSync(p, 'utf8');
  const refs = new Set();
  for (const m of src.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1]);
  for (const m of src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) refs.add(m[1]);
  for (const r of refs) {
    // Skip anything that is not a same-directory repo-relative path:
    // absolute URLs, protocol-relative, data:, anchors, mailto:,
    // javascript:, and ROOT-ABSOLUTE paths like "/TitleForge/" which
    // are resolved by GitHub Pages, not by the filesystem.
    if (/^(https?:|data:|#|mailto:|javascript:|\/\/|\/)/i.test(r)) continue;
    const clean = r.split(/[?#]/)[0];
    if (!clean) continue;
    if (!existsSync(resolve(join(ROOT, clean)))) fail(`  ${html} references missing asset: ${clean}`);
  }
}
for (const h of ['index.html', 'app.html', '404.html']) checkRefs(h);

for (const css of ['style.css', 'app.css', 'premium.css']) {
  const p = join(ROOT, css);
  if (!existsSync(p)) continue;
  for (const m of readFileSync(p, 'utf8').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const r = m[1];
    if (/^(https?:|data:|#)/i.test(r)) continue;
    const clean = r.split(/[?#]/)[0];
    if (clean && !existsSync(resolve(join(ROOT, clean)))) fail(`  ${css} references missing asset: ${clean}`);
  }
}

/* ---------- 4. secret guard ----------
   This is a GUARD, not a guarantee. It reports; a human decides. */
const SECRET_PATTERNS = [
  ['github classic token', /ghp_[A-Za-z0-9]{20,}/g],
  ['github fine-grained token', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['aws access key id', /AKIA[0-9A-Z]{16}/g],
  ['openai-style key', /\bsk-[A-Za-z0-9]{20,}/g],
  ['google api key', /\bAIza[A-Za-z0-9_\-]{30,}/g],
  ['bearer literal', /Bearer\s+[A-Za-z0-9._\-]{20,}/g],
];

// Fixture / documentation files are known-safe and are listed
// explicitly rather than silently skipped.
const ALLOW = new Set(['build.mjs']);

for (const f of SHIPPED.concat(['README.md', 'smoke.mjs', 'package.json'])) {
  if (ALLOW.has(f)) continue;
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  const body = readFileSync(p, 'utf8');
  for (const [name, re] of SECRET_PATTERNS) {
    const hits = body.match(re);
    if (hits) {
      for (const h of hits) {
        // redact: never echo a full credential into a log
        warn(`  POSSIBLE ${name} in ${f}: ${h.slice(0, 6)}…${h.slice(-2)} (${h.length} chars) — review before shipping`);
      }
    }
  }
}

/* ---------- 5. reduced-motion must be honoured ----------
   Non-negotiable #6: honour it or better, never worse.
   Every stylesheet that animates anything must have a guard. */
for (const css of ['style.css', 'app.css', 'premium.css']) {
  const p = join(ROOT, css);
  if (!existsSync(p)) continue;
  const body = readFileSync(p, 'utf8');
  if (/\b(animation|transition)\s*:/.test(body) && !/prefers-reduced-motion/.test(body)) {
    fail(`  ${css} animates but has no prefers-reduced-motion block — violates non-negotiable #6`);
  }
}

/* ---------- report ---------- */
const scanTargets = SHIPPED.filter(f => existsSync(join(ROOT, f)));
let bytes = 0;
for (const f of scanTargets) bytes += readFileSync(join(ROOT, f)).length;

console.log('TitleForge build check');
console.log('======================');
console.log(`  files checked : ${SHIPPED.length} (${bytes} bytes)`);
console.log(`  scripts       : 2 modules + inline <script> blocks`);

if (warnings.length) {
  console.log('\nWARNINGS (review manually):');
  for (const w of warnings) console.log(w);
}

if (errors.length) {
  console.log('\nBUILD FAILED:');
  for (const e of errors) console.log(e);
  console.log(`\n${errors.length} problem(s). Nothing shipped.`);
  process.exit(1);
}

console.log('\nBUILD OK — syntax, non-empty assets, references, secrets, reduced-motion.');
process.exit(0);
