#!/usr/bin/env node
// Finds the code that works on your laptop and breaks on serverless hosting.
//
//   node scan.mjs [project-folder]
//
// Every finding is a place to look, not a verdict. The patterns are chosen to
// catch the real bug with few false alarms, but a human (or the assistant)
// still reads each one before changing anything.
//
// No dependencies on purpose: it runs anywhere Node 18+ runs.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

const ROOT = process.argv[2] || process.cwd();

const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', '.vercel', '.turbo', '.output',
  'dist', 'build', 'out', 'coverage', 'public',
]);
const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

// Names that should never reach a browser bundle.
const SECRET_WORDS = /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|TOKEN|API_KEY|ACCESS_KEY/;

// ── walking the project ─────────────────────────────────────────────────────

function listCodeFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listCodeFiles(full));
    else if (CODE_EXT.has(extname(name))) out.push(full);
  }
  return out;
}

// Code that runs on the server per request: API routes, route handlers,
// server actions and middleware. Pages and components are left alone.
function isServerFile(path, text) {
  const p = path.split(sep).join('/');
  return (
    /\/route\.(js|ts|mjs)$/.test(p) ||
    /\/pages\/api\//.test(p) ||
    /(^|\/)api\/.+\.(js|ts|mjs)$/.test(p) ||
    /(^|\/)(middleware|proxy)\.(js|ts)$/.test(p) ||
    /^\s*['"]use server['"]/m.test(text)
  );
}

const isClientFile = (text) => /^\s*['"]use client['"]/m.test(text);

// ── the checks ──────────────────────────────────────────────────────────────
// Each check takes one file and returns findings: { line, rule, code }.

// after() and waitUntil() are the right way to run work past the response.
const BACKGROUND_OK = /^(after|waitUntil|ctx\.waitUntil|event\.waitUntil)\(/;

function unawaitedWork(lines) {
  const found = [];
  lines.forEach((code, i) => {
    const t = code.trim();
    if (/^(await|return|const|let|var|yield)\b/.test(t)) return;
    if (BACKGROUND_OK.test(t)) return;
    // A promise chain started as a statement: fetch(...).then(...), x.catch(...).
    // It must start with a name, so a line continuing an awaited chain
    // (".eq(...).then(...)") is not mistaken for a new statement.
    const chained = /^[A-Za-z_$][\w$.]*\(.*\)\s*\.(then|catch|finally)\(/.test(t);
    // A bare network call started as a statement and never awaited.
    const bareFetch = /^fetch\(/.test(t);
    if (chained || bareFetch) found.push({ line: i + 1, rule: 'unawaited', code: t });
  });
  return found;
}

function moduleState(lines) {
  const found = [];
  lines.forEach((code, i) => {
    // Column zero means module scope: it lives as long as the instance does.
    // Only empty collections and reassignable values count; a Set filled with
    // constants is a lookup table, not state.
    if (/^(const|let|var)\s+\w+\s*=\s*new\s+(Map|Set|WeakMap)\(\s*\)/.test(code) ||
        /^let\s+\w+\s*=/.test(code)) {
      found.push({ line: i + 1, rule: 'module-state', code: code.trim() });
    }
  });
  return found;
}

function timers(lines) {
  const found = [];
  lines.forEach((code, i) => {
    // setInterval never belongs in request code. setTimeout only when it is
    // fired and forgotten; an awaited sleep or an abort timer is fine.
    if (/\bsetInterval\s*\(/.test(code) || /^\s*setTimeout\s*\(/.test(code)) {
      found.push({ line: i + 1, rule: 'timer', code: code.trim() });
    }
  });
  return found;
}

function diskWrites(lines) {
  const found = [];
  lines.forEach((code, i) => {
    if (/\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|createWriteStream)\s*\(/.test(code) &&
        !/['"`]\/tmp/.test(code) && !/tmpdir\(\)/.test(code)) {
      found.push({ line: i + 1, rule: 'disk-write', code: code.trim() });
    }
  });
  return found;
}

function clientEnv(lines) {
  const found = [];
  lines.forEach((code, i) => {
    for (const [, name] of code.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!name.startsWith('NEXT_PUBLIC_') && name !== 'NODE_ENV') {
        found.push({ line: i + 1, rule: 'client-env', code: `${name}: ${code.trim()}` });
      }
    }
  });
  return found;
}

function publicSecrets(lines) {
  const found = [];
  lines.forEach((code, i) => {
    for (const [, name] of code.matchAll(/\b(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
      const rest = name.slice('NEXT_PUBLIC_'.length);
      if (SECRET_WORDS.test(rest) && !/PUBLISHABLE|ANON|PUBLIC_KEY|SITE_KEY/.test(rest)) {
        found.push({ line: i + 1, rule: 'public-secret', code: `${name}: ${code.trim()}` });
      }
    }
  });
  return found;
}

// ── vercel.json crons ───────────────────────────────────────────────────────

// True when a cron expression fires more than once a day, which the free
// plan refuses at deploy time.
function moreThanDaily(schedule) {
  const [minute, hour] = String(schedule).trim().split(/\s+/);
  const single = (field) => /^\d+$/.test(field || '');
  return !(single(minute) && single(hour));
}

function cronFindings(root) {
  const file = join(root, 'vercel.json');
  if (!existsSync(file)) return [];
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  const crons = Array.isArray(config.crons) ? config.crons : [];
  const found = [];
  if (crons.length > 100) {
    found.push({ line: 0, rule: 'cron-count', code: `${crons.length} cron jobs declared` });
  }
  for (const c of crons) {
    if (moreThanDaily(c.schedule)) {
      found.push({ line: 0, rule: 'cron-frequency', code: `${c.path}  "${c.schedule}"` });
    }
  }
  return found.map((f) => ({ ...f, file: 'vercel.json' }));
}

// ── what each rule means ────────────────────────────────────────────────────

const RULES = {
  'unawaited': 'Work started and never awaited. The function can stop as soon as it responds, so this is cut off part of the time. Await it, or hand it to after() / waitUntil().',
  'module-state': 'State held in memory at module level. Each instance has its own copy and loses it when recycled, so rate limits, dedupe and caches here are not shared. Move it to a database or KV store if correctness depends on it.',
  'timer': 'A timer left running in request code. It will not fire once the function has finished. Do the work now, or schedule it with a queue or cron.',
  'disk-write': 'Writing to disk outside /tmp. The deployment filesystem is read-only, and /tmp is per instance and temporary. Use storage (S3, Blob, Supabase Storage) for anything that must last.',
  'client-env': 'A server-only environment variable read in a "use client" file. It is undefined in the browser. Read it on the server, or rename it with NEXT_PUBLIC_ only if it is safe to publish.',
  'public-secret': 'A secret-looking name with the NEXT_PUBLIC_ prefix. Anything NEXT_PUBLIC_ is copied into the browser bundle for everyone to read. Rename it and use it server-side only.',
  'cron-count': 'More than 100 cron jobs in one project. Vercel allows 100 per project on every plan.',
  'cron-frequency': 'Runs more than once a day. The Hobby plan only allows daily crons and fails the deploy otherwise. Fine on Pro.',
};

const ORDER = ['public-secret', 'unawaited', 'client-env', 'module-state', 'timer', 'disk-write', 'cron-frequency', 'cron-count'];

// ── run ─────────────────────────────────────────────────────────────────────

function scan(root) {
  const findings = [];
  for (const path of listCodeFiles(root)) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/);
    const file = relative(root, path).split(sep).join('/');
    const add = (list) => list.forEach((f) => findings.push({ ...f, file }));

    add(publicSecrets(lines));
    if (isServerFile(path, text)) {
      add(unawaitedWork(lines));
      add(moduleState(lines));
      add(timers(lines));
      add(diskWrites(lines));
    }
    if (isClientFile(text)) add(clientEnv(lines));
  }
  return findings.concat(cronFindings(root));
}

function report(findings) {
  if (findings.length === 0) {
    console.log('No serverless traps found by the scanner.');
    console.log('It only catches the common shapes, so still read the checklist for anything it cannot see.');
    return;
  }
  console.log(`${findings.length} place(s) to look at:\n`);
  for (const rule of ORDER) {
    const group = findings.filter((f) => f.rule === rule);
    if (group.length === 0) continue;
    console.log(`## ${rule} (${group.length})`);
    console.log(RULES[rule]);
    for (const f of group) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  - ${where}  ${f.code.slice(0, 140)}`);
    }
    console.log('');
  }
}

if (!existsSync(ROOT)) {
  console.error(`No folder at ${ROOT}`);
  process.exit(1);
}
report(scan(ROOT));
