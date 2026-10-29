import { json, error, now, budgetFetch, getMeta } from "./util.js";
import { handleAuth, getSession } from "./auth.js";
import { getLibrary, handleSync, getItem, getItems, putItem } from "./store.js";
import { searchFilms, filmDetails, searchShows, showDetails, searchBooks, searchSeries, seriesDetails, ids } from "./providers.js";
import { backfill, daily, backup, refreshShow, refreshSeries } from "./jobs.js";

const IMG_SOURCES = {
  tmdb: rest => /^(w92|w154|w185|w342|w500|w780|original)\/[\w-]+\.(jpg|png|webp)$/.test(rest) && `https://image.tmdb.org/t/p/${rest}`,
  ol: rest => /^\d+$/.test(rest) && `https://covers.openlibrary.org/b/id/${rest}-L.jpg`,
  cv: rest => /^[\w\-./%]+$/.test(rest) && !rest.includes("..") && `https://comicvine.gamespot.com/a/uploads/${rest}`,
};

/* Cover art is copied into KV the first time it's shown, so it keeps working if a source goes down */
async function image(request, env, ctx, src, rest) {
  const origin = IMG_SOURCES[src]?.(rest);
  if (!origin) return error(400, "Unknown image");
  const key = `${src}/${rest}`;
  const headers = ct => ({ "content-type": ct, "cache-control": "private, max-age=31536000, immutable" });
  const hit = await env.COVERS.getWithMetadata(key, "arrayBuffer");
  if (hit.value) return new Response(hit.value, { headers: headers(hit.metadata?.ct || "image/jpeg") });
  const r = await fetch(origin, { headers: { "user-agent": "Stacks/1.0 (personal media tracker)" } });
  if (!r.ok) return new Response(null, { status: 404 });
  const buf = await r.arrayBuffer(), ct = r.headers.get("content-type") || "image/jpeg";
  if (buf.byteLength < 4e6 && ct.startsWith("image/")) ctx.waitUntil(env.COVERS.put(key, buf, { metadata: { ct } }).catch(() => {}));
  return new Response(buf, { headers: headers(ct) });
}

async function search(env, kind, q) {
  const f = budgetFetch(5);
  if (!q || q.trim().length < 2) return [];
  if (kind === "film") return searchFilms(env, f, q);
  if (kind === "tv") return searchShows(env, f, q);
  if (kind === "book") return searchBooks(env, f, q);
  if (kind === "comic") return searchSeries(env, f, q);
  throw new Error("Unknown kind");
}

/* Add something new from a search result. Returns the stored document. */
async function add(env, body) {
  const f = budgetFetch(45), { kind, ref } = body;
  if (kind === "film") {
    const meta = await filmDetails(env, f, ref);
    const existing = (await getItems(env, "film")).find(x => x.tmdb === meta.tmdb);
    if (existing) return { kind, doc: existing };
    const doc = { id: ids.film(meta.tmdb), rating: null, liked: false, lb: null, ...meta };
    await putItem(env, "film", doc.id, doc);
    return { kind, doc };
  }
  if (kind === "tv") {
    const id = ids.show(ref), existing = await getItem(env, "show", id);
    if (existing) return { kind, doc: existing };
    const d = await showDetails(env, f, ref);
    const doc = { id, status: "want", history: [], ...d, refreshed: now() };
    await putItem(env, "show", id, doc);
    return { kind, doc };
  }
  if (kind === "comic") {
    const id = ids.series(ref), existing = await getItem(env, "series", id);
    if (existing) return { kind, doc: existing };
    const d = await seriesDetails(env, f, ref);
    const doc = { id, volume: null, status: "want", history: [], ...d, refreshed: now() };
    await putItem(env, "series", id, doc);
    return { kind, doc };
  }
  throw new Error("Unknown kind");
}

/* Turn provider failures into something you can act on */
function friendly(e, kind) {
  const m = e.message || "";
  const src = { film: "TMDB", tv: "TMDB", book: "Open Library", comic: "Comic Vine" }[kind] || "the data source";
  if (/isn't set|aren't set/.test(m)) return `${m}. Add it with npx wrangler secret put, then try again.`;
  if (/ 401| 403|Invalid API Key/i.test(m)) return `${m.split(" ")[0]} rejected the key. Check it, then run npx wrangler secret put again.`;
  if (/ 429/.test(m)) return `${src} is rate-limiting requests. Wait a minute and try again.`;
  return `Couldn't reach ${src}. Try again in a moment.`;
}

async function status(env) {
  return {
    sources: { tmdb: !!env.TMDB_TOKEN, comicvine: !!env.COMICVINE_KEY, metron: !!(env.METRON_USER && env.METRON_PASS), backup: !!(env.GITHUB_TOKEN && env.GITHUB_REPO && !env.GITHUB_REPO.startsWith("PASTE_")) },
    lastDaily: await getMeta(env, "last_daily"), lastBackup: await getMeta(env, "last_backup"),
    failed: (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'film' AND deleted = 0 AND json_extract(data, '$.matchFailed') IS NOT NULL").first()).n,
    unmatched: (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'film' AND deleted = 0 AND json_extract(data, '$.tmdb') IS NULL AND json_extract(data, '$.matchFailed') IS NULL").first()).n,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    try {
      if (path.startsWith("/api/auth/")) {
        if (method !== "GET" && request.headers.get("x-stacks") !== "1") return error(403, "Missing request header");
        return await handleAuth(request, env, path);
      }
      if (path.startsWith("/api/") || path.startsWith("/img/")) {
        if (!(await getSession(request, env))) return error(401, "Sign in first.");
        if (method !== "GET" && request.headers.get("x-stacks") !== "1") return error(403, "Missing request header");
      }
      const img = path.match(/^\/img\/(tmdb|ol|cv)\/(.+)$/);
      if (img && method === "GET") return await image(request, env, ctx, img[1], img[2]);

      if (path === "/api/library" && method === "GET") return json(await getLibrary(env, +url.searchParams.get("since") || 0));
      if (path === "/api/sync" && method === "POST") return await handleSync(request, env);
      if (path === "/api/search" && method === "GET") {
        try { return json({ results: await search(env, url.searchParams.get("kind"), url.searchParams.get("q")) }); }
        catch (e) { return error(502, friendly(e, url.searchParams.get("kind"))); }
      }
      if (path === "/api/add" && method === "POST") {
        try { return json(await add(env, await request.json())); }
        catch (e) { return error(502, friendly(e, "add")); }
      }
      if (path === "/api/refresh" && method === "POST") {
        const { kind, id } = await request.json(), f = budgetFetch(45);
        try { return json({ doc: kind === "show" ? await refreshShow(env, f, id) : await refreshSeries(env, f, id) }); }
        catch (e) { return error(502, `Couldn't check for new ${kind === "show" ? "episodes" : "issues"} (${e.message}).`); }
      }
      if (path === "/api/status" && method === "GET") return json(await status(env));
      if (path === "/api/rematch" && method === "POST") {
        await env.DB.prepare("UPDATE items SET data = json_remove(data, '$.matchFailed', '$.matchErrors', '$.coverTried', '$.coverErrors'), updated_at = ? WHERE kind IN ('film','watchlist','book') AND deleted = 0 AND (json_extract(data, '$.matchFailed') IS NOT NULL OR (json_extract(data, '$.coverTried') IS NOT NULL AND json_extract(data, '$.cover') IS NULL))").bind(now()).run();
        return json({ ok: true });
      }
      if (path === "/api/export" && method === "GET") {
        const lib = await getLibrary(env, 0);
        return new Response(JSON.stringify({ exported: new Date().toISOString(), items: lib.items.map(({ kind, id, data }) => ({ kind, id, data })) }, null, 1), {
          headers: { "content-type": "application/json", "content-disposition": `attachment; filename="stacks-${new Date().toISOString().slice(0, 10)}.json"` },
        });
      }
      if (path.startsWith("/api/")) return error(404, "Not found");
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return error(500, "Something went wrong on the server. Check `npm run logs` for details.");
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron.startsWith("*/5")) ctx.waitUntil(backfill(env));
    else if (event.cron.startsWith("30 13")) ctx.waitUntil(daily(env));
    else ctx.waitUntil(backup(env));
  },
};


