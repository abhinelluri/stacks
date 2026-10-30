/* Scheduled jobs. Each run stays inside the free plan: few outbound requests, small batches. */
import { budgetFetch, now, today, getMeta, setMeta } from "./util.js";
import { getItem, putItem, getLibrary } from "./store.js";
import { matchFilm, filmDetails, bookExtras, showDetails, seriesDetails, seriesDetailsMetron, upcomingIssues, issueOrder } from "./providers.js";

const log = (...a) => console.log("[stacks]", ...a);

async function pick(env, kind, where, limit) {
  return (await env.DB.prepare(`SELECT id, data FROM items WHERE kind = ? AND deleted = 0 AND ${where} LIMIT ?`).bind(kind, limit).all())
    .results.map(r => ({ id: r.id, doc: JSON.parse(r.data) }));
}

/* Every 5 minutes: match imported films / watchlist / books to TMDB and Open Library */
export async function backfill(env) {
  const f = budgetFetch(40);
  if (env.TMDB_TOKEN) {
    for (const kind of ["film", "watchlist"]) {
      const rows = await pick(env, kind, "json_extract(data, '$.tmdb') IS NULL AND json_extract(data, '$.matchFailed') IS NULL", 5);
      for (const { id } of rows) {
        if (f.left() < 4) break;
        const fresh = await getItem(env, kind, id);
        if (!fresh) continue;
        try {
          const tid = await matchFilm(env, f, fresh.title, fresh.year);
          const meta = tid ? await filmDetails(env, f, tid) : null;
          const latest = await getItem(env, kind, id);  // re-read: keep edits made meanwhile, and skip if you removed it
          if (!latest) continue;
          await putItem(env, kind, id, meta
            ? { ...latest, tmdb: meta.tmdb, poster: meta.poster, runtime: meta.runtime, directors: meta.directors, cast: meta.cast, genres: meta.genres }
            : { ...latest, matchFailed: true });
        } catch (e) {
          log("film match", id, e.message);
          if (e.message === "budget") break;
          const n = (fresh.matchErrors || 0) + 1;                 // give up on a title after 3 failed tries
          await putItem(env, kind, id, { ...fresh, matchErrors: n, ...(n >= 3 ? { matchFailed: true } : {}) });
        }
      }
    }
  }
  const books = await pick(env, "book", "json_extract(data, '$.cover') IS NULL AND json_extract(data, '$.coverTried') IS NULL", 4);
  for (const { id, doc } of books) {
    if (f.left() < 3) break;
    try {
      const x = await bookExtras(env, f, doc);
      const latest = await getItem(env, "book", id);
      if (!latest) continue;
      await putItem(env, "book", id, { ...latest, cover: x?.cover ?? null, pages: latest.pages ?? x?.pages ?? null, coverTried: true });
    } catch (e) {
      log("book cover", id, e.message);
      if (e.message === "budget") break;
      const n = (doc.coverErrors || 0) + 1;
      await putItem(env, "book", id, { ...doc, coverErrors: n, ...(n >= 3 ? { coverTried: true } : {}) });
    }
  }
}

/* Move a caught-up show/series back to Watching/Reading when something new is out, and vice versa */
export function autoStatus(kind, x) {
  const t = today();
  const units = kind === "show" ? x.seasons.flatMap(s => s.episodes).map(e => ({ out: !e.airdate || e.airdate <= t, done: e.watched != null }))
    : x.issues.slice(Math.max(0, x.startAt != null ? x.issues.findIndex(i => String(i.n) === String(x.startAt)) : x.issues.findIndex(i => parseFloat(i.n) >= 1))).map(i => ({ out: !i.released || i.released <= t, done: i.read != null }));
  const out = units.filter(u => u.out), active = kind === "show" ? "watching" : "reading";
  const set = s => { if (x.status !== s) { x.status = s; (x.history ||= []).push({ s, d: t }); } };
  if (x.status === "caught" && out.some(u => !u.done)) set(active);
  else if (x.status === active && out.length && out.every(u => u.done)) set(x.ongoing ? "caught" : "finished");
  return x;
}

function mergeEpisodes(fresh, fetched) {
  const prev = new Map(fresh.seasons.flatMap(s => s.episodes.map(e => [`${s.n}:${e.n}`, e])));
  fetched.seasons.forEach(s => s.episodes.forEach(e => { const p = prev.get(`${s.n}:${e.n}`); if (p) { e.watched = p.watched; e.rating = p.rating; } }));
  return fetched.seasons;
}
function mergeIssues(fresh, fetched) {
  const prev = new Map(fresh.issues.map(i => [String(i.n), i]));
  const issues = fetched.issues.map(i => { const p = prev.get(String(i.n)); return p ? { ...i, read: p.read, rating: p.rating } : i; });
  for (const [n, p] of prev) if (!issues.some(i => i.n === n)) issues.push(p);
  return issues.sort(issueOrder);
}

export async function refreshShow(env, f, id) {
  const fresh = await getItem(env, "show", id);
  if (!fresh?.tmdb) return fresh;
  const d = await showDetails(env, f, fresh.tmdb, fresh, true);
  const latest = await getItem(env, "show", id);
  if (!latest) return null;
  const doc = autoStatus("show", { ...latest, title: d.title, poster: d.poster || latest.poster, ongoing: d.ongoing, network: d.network, genres: d.genres, seasons: mergeEpisodes(latest, d), refreshed: now() });
  await putItem(env, "show", id, doc);
  return doc;
}

export async function refreshSeries(env, f, id) {
  const fresh = await getItem(env, "series", id);
  if (!fresh) return null;
  let doc = { ...fresh };
  if (fresh.cv && env.COMICVINE_KEY) {
    const d = await seriesDetails(env, f, fresh.cv, fresh);
    doc = { ...doc, cover: d.cover || doc.cover, ongoing: d.ongoing, end: d.end, issues: d.issues };
  } else if (!fresh.cv && fresh.metron && env.METRON_USER) {
    const d = await seriesDetailsMetron(env, f, fresh.metron, fresh);
    doc = { ...doc, cover: doc.cover || d.cover, ongoing: d.ongoing, end: d.end, issues: d.issues };
  }
  if (env.METRON_USER && env.METRON_PASS && doc.ongoing !== false) {
    try {
      const up = await upcomingIssues(env, f, doc);
      doc.metron = up.metron;
      for (const u of up.issues) {
        const have = doc.issues.find(i => i.n === u.n);
        if (have) have.released = have.released || u.released;
        else doc.issues.push({ n: u.n, title: "", released: u.released, cover: null, read: null, rating: null });
      }
      if (up.issues.length) doc.ongoing = true;
    } catch (e) { log("metron", id, e.message); }
  }
  const latest = await getItem(env, "series", id);
  if (!latest) return null;
  doc = autoStatus("series", { ...latest, cover: doc.cover, ongoing: doc.ongoing, end: doc.end, metron: doc.metron, issues: mergeIssues(latest, doc), refreshed: now() });
  await putItem(env, "series", id, doc);
  return doc;
}

/* Daily: new episodes and issues for everything you're following, then tidy up */
export async function daily(env) {
  const f = budgetFetch(44);
  const order = "CASE WHEN json_extract(data, '$.status') IN ('watching','reading','caught','paused') THEN 0 ELSE 1 END, COALESCE(json_extract(data, '$.refreshed'), 0)";
  const active = "json_extract(data, '$.status') IN ('watching','reading','caught','paused')";
  const shows = (await env.DB.prepare(`SELECT id FROM items WHERE kind = 'show' AND deleted = 0 AND ${active} ORDER BY ${order} LIMIT 5`).all()).results;
  for (const { id } of shows) { if (f.left() < 6) break; try { await refreshShow(env, f, id); } catch (e) { log("show", id, e.message); } }
  const series = (await env.DB.prepare(`SELECT id FROM items WHERE kind = 'series' AND deleted = 0 AND ${active} ORDER BY ${order} LIMIT 6`).all()).results;
  for (const { id } of series) { if (f.left() < 5) break; try { await refreshSeries(env, f, id); } catch (e) { log("series", id, e.message); } }

  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM items WHERE deleted = 1 AND updated_at < ?").bind(t - 90 * 864e5),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM pair_codes WHERE expires_at < ?").bind(t),
  ]);
  await setMeta(env, "last_daily", t);
}

/* Sundays: commit a full copy of the library to backups/library.json in your GitHub repo */
export async function backup(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || env.GITHUB_REPO.startsWith("PASTE_")) return log("backup skipped: GITHUB_TOKEN or GITHUB_REPO not set");
  const lib = await getLibrary(env, 0);
  const text = JSON.stringify({ exported: new Date().toISOString(), items: lib.items.map(({ kind, id, data }) => ({ kind, id, data })) });
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const api = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/backups/library.json`;
  const headers = { authorization: `Bearer ${env.GITHUB_TOKEN}`, "user-agent": "stacks-backup", accept: "application/vnd.github+json" };
  const cur = await fetch(api, { headers });
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const r = await fetch(api, { method: "PUT", headers, body: JSON.stringify({ message: `Weekly backup ${today()}`, content: btoa(bin), ...(sha ? { sha } : {}) }) });
  if (!r.ok) throw new Error(`GitHub backup failed: ${r.status} ${await r.text()}`);
  await setMeta(env, "last_backup", now());
}
