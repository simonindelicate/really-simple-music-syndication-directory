#!/usr/bin/env node
/**
 * Keeps directory.json up to date. Run by the GitHub Action, or by hand:
 *
 *   node scripts/check.mjs new    add queued submissions (run hourly)
 *   node scripts/check.mjs full   also recheck every listed catalogue and merge in peers' lists (run daily)
 *
 * Environment (both optional):
 *   WORKER_URL    the submission Worker's address (otherwise config.json's workerUrl)
 *   WORKER_TOKEN  the Worker's TOKEN secret, needed to read its queue
 *
 * Rules, applied mechanically, never editorially:
 *   - a catalogue is listed if it works and is shared with other sites;
 *   - one made private by its owner (403, or no CORS header) is dropped at once;
 *   - one that's broken or unreachable is dropped after `dropAfterFailures` daily checks in a row;
 *   - catalogues another directory lists are checked and added; removals never come from peers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise, inspect } from '../worker/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'directory.json');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const mode = process.argv[2] === 'full' ? 'full' : 'new';
const workerUrl = (process.env.WORKER_URL || config.workerUrl || '').replace(/\/+$/, '');
const token = process.env.WORKER_TOKEN || '';
const now = new Date().toISOString();
const log = [];
const say = s => { log.push(s); console.log(s); };

const directory = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { catalogues: [] };
const listed = new Map((directory.catalogues || []).map(c => [c.url, c]));
const before = JSON.stringify([...listed.values()].map(({ lastChecked, ...c }) => c));

// 1. Gather candidates: queued submissions, a local submissions.txt, and peers' lists.
const candidates = new Set();
// An operator may refuse particular addresses in their own copy; that affects only this copy.
const excluded = new Set((config.exclude || []).map(normalise).filter(Boolean));
for (const u of excluded) listed.delete(u);
const consider = raw => { const u = normalise(raw); if (u && !listed.has(u) && !excluded.has(u)) candidates.add(u); };
let queued = [];
if (workerUrl && token) {
  try {
    const r = await fetch(workerUrl + '/pending', { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) { queued = (await r.json()).urls || []; queued.forEach(consider); say(`Queue: ${queued.length} submission(s).`); }
    else say(`Queue: the Worker answered ${r.status}.`);
  } catch (e) { say(`Queue: couldn't reach the Worker (${e.message}).`); }
}
const localFile = path.join(ROOT, 'submissions.txt');
if (fs.existsSync(localFile)) fs.readFileSync(localFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).forEach(consider);
for (const peer of mode === 'full' ? config.peers || [] : []) { // once a day is plenty
  try {
    const r = await fetch(peer, { headers: { Accept: 'application/json' } });
    const data = await r.json();
    const urls = (data.catalogues || []).map(c => c && c.url).filter(Boolean);
    let n = 0; for (const u of urls) { const b = normalise(u); if (b && !listed.has(b) && !candidates.has(b) && !excluded.has(b)) { candidates.add(b); n++; } }
    say(`Peer ${peer}: ${urls.length} listed, ${n} new to check.`);
  } catch (e) { say(`Peer ${peer}: couldn't be read (${e.message}).`); }
}

// 2. Check: new candidates always, everything listed on a full run.
const toCheck = [...candidates, ...(mode === 'full' ? listed.keys() : [])];
const results = new Map();
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < toCheck.length) { const u = toCheck[next++]; results.set(u, await inspect(u).catch(e => ({ ok: false, reason: e.message }))); }
}));

let added = 0, dropped = 0, failing = 0;
for (const [u, r] of results) {
  const entry = listed.get(u);
  if (!entry) {
    if (r.ok) { listed.set(u, { url: u, feed: u + '/catalogue', ...r.meta, firstSeen: now, lastChecked: now, lastOk: now, failures: 0 }); added++; say(`+ ${u} (${r.meta.name})`); }
    else say(`  not added: ${u}: ${r.reason}`);
    continue;
  }
  if (r.ok) { listed.set(u, { url: u, feed: u + '/catalogue', ...r.meta, firstSeen: entry.firstSeen, lastChecked: now, lastOk: now, failures: 0 }); continue; }
  if (r.optOut) { listed.delete(u); dropped++; say(`- ${u}: ${r.reason}`); continue; }
  entry.failures = (entry.failures || 0) + 1; entry.lastChecked = now; entry.lastError = r.reason;
  if (entry.failures >= (config.dropAfterFailures || 7)) { listed.delete(u); dropped++; say(`- ${u}: failed ${entry.failures} checks in a row (${r.reason})`); }
  else { failing++; say(`! ${u}: ${r.reason} (${entry.failures} in a row)`); }
}

// 3. Write the list, if anything other than check times changed (or on a full run, so check times stay current).
const catalogues = [...listed.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }) || a.url.localeCompare(b.url));
const changed = JSON.stringify(catalogues.map(({ lastChecked, ...c }) => c)) !== before;
if (changed || mode === 'full' || !fs.existsSync(FILE)) {
  const out = {
    directoryVersion: '1',
    name: config.name,
    description: config.description,
    repository: config.repository || undefined,
    submit: config.workerUrl ? config.workerUrl.replace(/\/+$/, '') + '/submit' : undefined,
    peers: config.peers && config.peers.length ? config.peers : undefined,
    updated: now,
    count: catalogues.length,
    catalogues
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 1) + '\n');
}
say(`Done (${mode}): ${catalogues.length} listed, ${added} added, ${dropped} dropped, ${failing} failing.${changed ? '' : ' No changes to the list.'}`);

// 4. Clear the processed queue (successes and failures alike: a rejected submission can simply be sent again).
if (workerUrl && token && queued.length) {
  try { await fetch(workerUrl + '/pending/done', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: queued }) }); }
  catch (e) { say(`Couldn't clear the queue (${e.message}); it will be retried.`); }
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + log.join('\n') + '\n```\n');
