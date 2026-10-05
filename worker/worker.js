/**
 * Catalogue directory: submission Worker.
 *
 * A Cloudflare Worker (free plan is plenty) that takes submissions for the directory.
 * It checks that the address really serves a catalogue that's shared with other sites,
 * then queues it. The directory's scheduled GitHub Action collects the queue and adds
 * the catalogue to directory.json. Nothing here decides who may be listed: any working,
 * shared catalogue is accepted.
 *
 * Routes
 *   POST /submit      { "url": "https://their-site.example" }   from the directory page
 *   GET  /ping?url=…  the same, for software that announces a catalogue when it's published
 *   GET  /pending     the queue, for the GitHub Action          (needs the TOKEN secret)
 *   POST /pending/done { "urls": [...] } clear processed entries (needs the TOKEN secret)
 *
 * Bindings: a KV namespace bound as QUEUE, and a secret called TOKEN.
 *
 * This one file also holds the shared rules for reading a catalogue, which the
 * directory's own checker (scripts/check.mjs) imports, so both apply the same tests.
 * It can be pasted as-is into the Cloudflare dashboard's Worker editor.
 */

export const LIMITS = { timeoutMs: 15000, maxBytes: 10 * 1024 * 1024 };

/** Turn whatever someone typed into a catalogue's base address, or null. */
export function normalise(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  // Public web addresses only.
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return null;
  const path = u.pathname.replace(/\/+$/, '').replace(/\/catalogue(\.json)?$/i, '').replace(/\/+$/, '');
  return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}${path}`;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '') || undefined;
const absolute = (v, base) => { if (typeof v !== 'string' || !v) return undefined; try { const u = new URL(v, base + '/'); return /^https?:$/.test(u.protocol) ? u.href : undefined; } catch (_) { return undefined; } };

/**
 * Fetch and check one catalogue. Resolves to
 *   { ok: true, meta }                      a working catalogue, shared with other sites
 *   { ok: false, optOut: true, reason }     its owner has made it private (drop at once)
 *   { ok: false, reason }                   broken or unreachable (may be temporary)
 */
export async function inspect(base, fetchImpl = fetch) {
  const feed = base + '/catalogue';
  let res;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), LIMITS.timeoutMs);
  try {
    res = await fetchImpl(feed, { headers: { Accept: 'application/json', 'User-Agent': 'rsms-directory (+https://github.com/simonindelicate/really-simple-music-syndication-directory)' }, redirect: 'follow', signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: `couldn't be reached (${e.name === 'AbortError' ? 'timed out' : 'network error'})` };
  }
  try {
    if (res.status === 403) return { ok: false, optOut: true, reason: 'the site says its catalogue is private (403)' };
    if (!res.ok) return { ok: false, reason: `the catalogue address answered ${res.status}` };
    // A catalogue must be readable by other sites; without this header its owner has kept it to their own site.
    if ((res.headers.get('access-control-allow-origin') || '').trim() !== '*') return { ok: false, optOut: true, reason: "the catalogue isn't shared with other sites (no Access-Control-Allow-Origin: * header)" };
    const length = Number(res.headers.get('content-length')) || 0;
    if (length > LIMITS.maxBytes) return { ok: false, reason: 'the catalogue file is too large' };
    const body = await res.text();
    if (body.length > LIMITS.maxBytes) return { ok: false, reason: 'the catalogue file is too large' };
    let data; try { data = JSON.parse(body); } catch (_) { return { ok: false, reason: "the catalogue isn't valid JSON" }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: "the catalogue isn't a JSON object" };
    const inst = data.instance && typeof data.instance === 'object' ? data.instance : null;
    if (!inst || !text(inst.name, 200)) return { ok: false, reason: 'the catalogue has no instance.name' };
    if (!Array.isArray(data.releases)) return { ok: false, reason: 'the catalogue has no releases array' };
    let tracks = 0, playable = 0, art; const artists = new Set(), genres = new Set();
    for (const r of data.releases) {
      if (!r || typeof r !== 'object' || !Array.isArray(r.tracks)) continue;
      if (text(r.artist, 120)) artists.add(text(r.artist, 120));
      if (text(r.genre, 60)) genres.add(text(r.genre, 60));
      if (!art) art = absolute(r.artworkUrl, base);
      for (const t of r.tracks) { if (!t || typeof t !== 'object') continue; tracks++; if (t.audioUrl && !t.gated) playable++; }
    }
    if (!playable) return { ok: false, reason: 'the catalogue has no playable tracks' };
    return {
      ok: true,
      meta: {
        name: text(inst.name, 200),
        description: text(inst.description, 400),
        site: absolute(inst.url, base) || base + '/',
        logoUrl: absolute(inst.logoUrl, base),
        artworkUrl: art,
        releases: data.releases.length,
        tracks,
        playable,
        artists: [...artists].slice(0, 8),
        genres: [...genres].slice(0, 8),
        feedVersion: text(data.feedVersion, 10),
        generatedAt: text(data.generatedAt, 40)
      }
    };
  } finally { clearTimeout(timer); }
}

/* ------------------------------ the Worker ------------------------------ */

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const authorised = (req, env) => env.TOKEN && req.headers.get('authorization') === `Bearer ${env.TOKEN}`;

async function submit(raw, env) {
  const base = normalise(raw);
  if (!base) return json(400, { ok: false, reason: "That doesn't look like a web address." });
  const key = 'p:' + base;
  if (await env.QUEUE.get(key)) return json(200, { ok: true, url: base, queued: true, message: "It's already in the queue, and will appear in the directory shortly." });
  const r = await inspect(base);
  if (!r.ok) return json(422, { ok: false, url: base, reason: `No shareable catalogue found at ${base}/catalogue: ${r.reason}.` });
  await env.QUEUE.put(key, JSON.stringify({ at: new Date().toISOString(), name: r.meta.name }), { expirationTtl: 14 * 86400 });
  return json(200, { ok: true, url: base, name: r.meta.name, message: `Found "${r.meta.name}", with ${r.meta.playable} playable track${r.meta.playable === 1 ? '' : 's'}. It will appear in the directory within the hour.` });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/submit' && req.method === 'POST') {
        let body = {};
        const type = req.headers.get('content-type') || '';
        if (type.includes('application/json')) body = await req.json().catch(() => ({}));
        else if (type.includes('form')) body = Object.fromEntries(await req.formData());
        return await submit(body.url, env);
      }
      if (url.pathname === '/ping' && req.method === 'GET') return await submit(url.searchParams.get('url'), env);
      if (url.pathname === '/pending' && req.method === 'GET') {
        if (!authorised(req, env)) return json(401, { ok: false });
        const urls = []; let cursor;
        do { const page = await env.QUEUE.list({ prefix: 'p:', cursor }); urls.push(...page.keys.map(k => k.name.slice(2))); cursor = page.list_complete ? null : page.cursor; } while (cursor);
        return json(200, { ok: true, urls });
      }
      if (url.pathname === '/pending/done' && req.method === 'POST') {
        if (!authorised(req, env)) return json(401, { ok: false });
        const { urls = [] } = await req.json().catch(() => ({}));
        for (const u of urls.slice(0, 1000)) await env.QUEUE.delete('p:' + u);
        return json(200, { ok: true, cleared: Math.min(urls.length, 1000) });
      }
      if (url.pathname === '/' && req.method === 'GET') return json(200, { ok: true, service: 'catalogue directory submissions', submit: 'POST /submit {"url": "..."} or GET /ping?url=...' });
      return json(404, { ok: false, reason: 'Not found' });
    } catch (e) {
      return json(500, { ok: false, reason: 'Something went wrong; please try again.' });
    }
  }
};
