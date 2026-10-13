#!/usr/bin/env node
/**
 * generate-dummy-history.js — creates a fake Extended History export for load testing.
 *
 * Usage:
 *   node generate-dummy-history.js [--size-mb 400] [--years 10] [--format json|tsv] [--out dummy-history.json] [--seed 1]
 *
 *   --format defaults to json, or to tsv when --out ends in .tsv (and the default file name follows the format).
 *
 * json: the same format the extension exports ({exportedAt, totalEntries, entries:[...]}),
 *        with the slim entry shape: url, title, visitTime, domain (+ rawUrl only when it differs).
 * tsv:  one visit per line like History Trends Unlimited exports:  url <TAB> U<timestamp ms> <TAB> 0 <TAB> title
 * The file is streamed to disk, so memory use stays small even for multi-GB output.
 * Entries are ordered newest → oldest, spread over the last N years with a realistic
 * daily rhythm (busy evenings, quiet nights, lighter weekends, some very heavy and some empty days).
 */
'use strict';
const fs = require('fs');

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const SIZE_MB = parseFloat(opt('size-mb', '400'));
const YEARS   = parseFloat(opt('years', '10'));
const FORMAT  = (opt('format', /\.tsv$/i.test(opt('out', '')) ? 'tsv' : 'json')).toLowerCase();
if (FORMAT !== 'json' && FORMAT !== 'tsv') { console.error('--format must be json or tsv'); process.exit(1); }
const OUT     = opt('out', FORMAT === 'tsv' ? 'dummy-history.tsv' : 'dummy-history.json');
let   seed    = parseInt(opt('seed', '1'), 10) >>> 0;
if (!(SIZE_MB > 0) || !(YEARS > 0)) { console.error('--size-mb and --years must be positive numbers'); process.exit(1); }

// ── Seeded PRNG (mulberry32) so runs are reproducible ────────────────────────
function rand() {
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri   = (n) => Math.floor(rand() * n);
const pick = (a) => a[ri(a.length)];

// ── Vocabulary ───────────────────────────────────────────────────────────────
const WORDS = ('how to best guide review price cheap fast new latest update free download install setup fix error issue ' +
  'laptop phone camera battery monitor keyboard mouse router server docker linux windows android chrome python javascript ' +
  'react node database index query cache memory speed benchmark compare versus vs tutorial example course lesson video ' +
  'recipe pasta chicken salad bread soup travel flight hotel train bus map weather news sports score match season ' +
  'movie series episode music album song lyrics game level walkthrough tips tricks list top ten 2015 2018 2021 2024 ' +
  'health sleep running yoga home garden tools paint wood steel energy solar car engine oil tires bike helmet').split(' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const phrase = (min, max) => { const n = min + ri(max - min + 1); const w = []; for (let i = 0; i < n; i++) w.push(pick(WORDS)); return w; };
const slug   = (w) => w.join('-');
const title  = (w) => w.map(cap).join(' ');

// Popular sites (heavily weighted) with their URL/title shapes
const HEAD = [
  { d: 'www.google.com',        w: 30, mk: () => { const w = phrase(1, 4); return [`/search?q=${w.join('+')}&oq=${w.join('+')}&sourceid=chrome&ie=UTF-8`, `${w.join(' ')} - Google Search`]; } },
  { d: 'www.youtube.com',       w: 22, mk: () => { const w = phrase(2, 5); return [`/watch?v=${id(11)}`, `${title(w)} - YouTube`]; } },
  { d: 'github.com',            w: 8,  mk: () => { const w = phrase(1, 2); return [`/${pick(WORDS)}${ri(99)}/${slug(w)}/issues/${1 + ri(4000)}`, `${title(w)} · Issue #${1 + ri(4000)}`]; } },
  { d: 'stackoverflow.com',     w: 6,  mk: () => { const w = phrase(4, 9); return [`/questions/${10000000 + ri(70000000)}/${slug(w)}`, `${cap(w.join(' '))}? - Stack Overflow`]; } },
  { d: 'www.reddit.com',        w: 7,  mk: () => { const w = phrase(3, 8); return [`/r/${pick(WORDS)}${ri(50)}/comments/${id(6)}/${slug(w)}/`, `${cap(w.join(' '))} : r/${pick(WORDS)}`]; } },
  { d: 'en.wikipedia.org',      w: 5,  mk: () => { const w = phrase(1, 3); return [`/wiki/${w.map(cap).join('_')}`, `${title(w)} - Wikipedia`]; } },
  { d: 'www.amazon.de',         w: 4,  mk: () => { const w = phrase(3, 7); return [`/dp/B0${id(8).toUpperCase()}?psc=1`, `${title(w)}: Amazon.de`]; } },
  { d: 'mail.google.com',       w: 6,  mk: () => [`/mail/u/0/#inbox/${id(16)}`, 'Inbox - Gmail'] },
  { d: 'www.facebook.com',      w: 3,  mk: () => [`/${pick(WORDS)}.${pick(WORDS)}${ri(999)}/posts/${id(15)}`, 'Facebook'] },
  { d: 'twitter.com',           w: 3,  mk: () => [`/${pick(WORDS)}${ri(999)}/status/${1e17 + ri(9e15)}`, 'X / Twitter'] },
  { d: 'developer.mozilla.org', w: 3,  mk: () => { const w = phrase(1, 3); return [`/en-US/docs/Web/API/${w.map(cap).join('_')}`, `${title(w)} - MDN Web Docs`]; } },
  { d: 'docs.google.com',       w: 3,  mk: () => { const w = phrase(1, 4); return [`/document/d/${id(40)}/edit`, `${title(w)} - Google Docs`]; } },
];
const TLDS = ['com', 'com', 'com', 'net', 'org', 'io', 'de', 'co.uk', 'me', 'dev', 'info'];
function id(n) { const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'; let s = ''; for (let i = 0; i < n; i++) s += c[ri(c.length)]; return s; }

// Long tail: ~3000 generated sites, each with its own favourite page shapes
const TAIL = [];
for (let i = 0; i < 3000; i++) {
  const name = pick(WORDS) + pick(WORDS) + (rand() < 0.3 ? ri(99) : '');
  const d = (rand() < 0.55 ? 'www.' : '') + name + '.' + pick(TLDS);
  const sec = pick(WORDS);
  TAIL.push({
    d,
    w: 1 / (1 + i / 40),                      // Zipf-ish: a few busy tail sites, many rarely visited
    mk: () => { const w = phrase(2, 7);
      return rand() < 0.5
        ? [`/${sec}/${slug(w)}-${id(5)}`, `${title(w)} | ${cap(name)}`]
        : [`/${ri(2025)}/${1 + ri(12)}/${slug(w)}/`, `${cap(w.join(' '))} - ${cap(name)}`]; },
  });
}
const SITES = HEAD.concat(TAIL);
const CUM = []; let tot = 0; for (const s of SITES) { tot += s.w; CUM.push(tot); }
function pickSite() { const r = rand() * tot; let lo = 0, hi = CUM.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (CUM[m] < r) lo = m + 1; else hi = m; } return SITES[lo]; }

function makeEntry(visitTime) {
  const s = pickSite();
  const [path, ttl] = s.mk();
  const url = `https://${s.d}${path}`;
  const e = { url, title: ttl, visitTime, domain: s.d };
  if (rand() < 0.07) e.rawUrl = url + (url.includes('?') ? '&' : '?') + 'utm_source=' + pick(WORDS) + '&utm_medium=' + pick(WORDS);
  return e;
}

// One entry → its serialized form for the chosen format (no leading separator)
const clean = (t) => String(t).replace(/[\t\r\n]+/g, ' ');
const serialize = FORMAT === 'tsv'
  ? (e) => `${e.rawUrl || e.url}\tU${e.visitTime}\t0\t${clean(e.title)}\n`
  : (e) => JSON.stringify(e);
const SEP = FORMAT === 'tsv' ? '' : ',';

// ── Calibrate: average serialized bytes per entry → how many entries for SIZE_MB ──
let sample = 0;
for (let i = 0; i < 5000; i++) sample += Buffer.byteLength(serialize(makeEntry(1790000000000.123)), 'utf8') + SEP.length; // + "," and indent-free overhead
const AVG    = sample / 5000;
const TARGET = SIZE_MB * 1024 * 1024;
const N      = Math.round(TARGET / AVG);

// ── Timeline ─────────────────────────────────────────────────────────────────
const DAY   = 86400000;
const DAYS  = Math.round(YEARS * 365.25);
const NOW   = Date.now();
// Relative activity by hour of day (0–23): quiet night, busy evening
const HOUR_W = [1, .5, .3, .2, .2, .4, 1.2, 2.5, 3.5, 4, 4, 4, 4.5, 4, 4, 4, 4.5, 5, 6, 7, 7.5, 7, 5, 2.5];
const HC = []; { let t = 0; for (const w of HOUR_W) { t += w; HC.push(t); } }
function pickHour() { const r = rand() * HC[23]; for (let h = 0; h < 24; h++) if (r <= HC[h]) return h; return 23; }

// ── Streaming writer ─────────────────────────────────────────────────────────
(async () => {
  const out = fs.createWriteStream(OUT, { encoding: 'utf8' });
  let buf = '', bytes = 0, written = 0;
  const flush = async () => {
    if (!buf) return;
    bytes += Buffer.byteLength(buf, 'utf8');
    if (!out.write(buf)) await new Promise(r => out.once('drain', r));
    buf = '';
  };

  // header — totalEntries is patched at the end (same width reserved)
  const header = `{"exportedAt":"${new Date(NOW).toISOString()}","totalEntries":`;
  const PLACEHOLDER = '0'.repeat(10);
  if (FORMAT === 'json') buf += header + PLACEHOLDER + ',"entries":[';
  const patchOffset = Buffer.byteLength(header, 'utf8');

  const startTs = Date.now();
  let first = true;
  const midnightToday = new Date(NOW); midnightToday.setHours(0, 0, 0, 0);

  // Pre-compute every day's relative activity, then scale so the total is exactly N and the
  // data spans the whole period (newest day = today, oldest day = YEARS ago).
  const dayW = new Float64Array(DAYS); let wSum = 0;
  for (let d = 0; d < DAYS; d++) {
    const dow = new Date(midnightToday.getTime() - d * DAY).getDay();
    const mood = rand() < 0.04 ? 0 : (0.25 + rand() * 1.5) * (rand() < 0.03 ? 4 : 1); // empty days, normal days, rare marathon days
    dayW[d] = (dow === 0 || dow === 6 ? 0.75 : 1.08) * mood;
    wSum += dayW[d];
  }
  let carry = 0;

  for (let d = 0; d < DAYS && written < N; d++) {
    const dayStart = midnightToday.getTime() - d * DAY;
    const exact = dayW[d] / wSum * N + carry;
    let count = Math.round(exact); carry = exact - count;
    if (d === DAYS - 1 || written + count > N) count = Math.min(count, N - written);
    if (count <= 0) continue;
    const times = new Array(count);
    for (let i = 0; i < count; i++) {
      const t = dayStart + pickHour() * 3600000 + ri(3600000) + Math.round(rand() * 1000) / 1000;
      times[i] = Math.min(t, NOW);
    }
    times.sort((a, b) => b - a);
    for (const t of times) {
      buf += (first ? '' : SEP) + serialize(makeEntry(t));
      first = false; written++;
    }
    if (buf.length > 1 << 20) await flush();
    if (d % 100 === 0 && process.stdout.isTTY) process.stdout.write(`\r${written.toLocaleString()} / ${N.toLocaleString()} entries  (${(bytes / 1048576).toFixed(0)} MB)   `);
  }

  // If the random day-weights left us short, top up with extra visits on random days so the size target is met
  while (written < N) {
    const t = NOW - rand() * DAYS * DAY;
    buf += (first ? '' : SEP) + serialize(makeEntry(t)); first = false; written++;
    if (buf.length > 1 << 20) await flush();
  }

  if (FORMAT === 'json') buf += ']}';
  await flush();
  await new Promise(r => out.end(r));

  // patch totalEntries in place
  if (FORMAT === 'json') {
    const fd = fs.openSync(OUT, 'r+');
    fs.writeSync(fd, Buffer.from(String(written).padStart(PLACEHOLDER.length, ' ')), 0, PLACEHOLDER.length, patchOffset);
    fs.closeSync(fd);
  }

  const mb = fs.statSync(OUT).size / 1048576;
  console.log(`\nDone: ${OUT} (${FORMAT})\n  ${written.toLocaleString()} entries, ${mb.toFixed(1)} MB, ~${YEARS} years ` +
              `(${Math.round(written / DAYS)} entries/day avg), ${((Date.now() - startTs) / 1000).toFixed(1)} s`);
})().catch(e => { console.error(e); process.exit(1); });