/* Outside data sources. Every function takes `f`, a fetch with a request budget (see util.budgetFetch). */
import { today } from "./util.js";

const UA = "Stacks/1.0 (personal media tracker)";
const year = d => (d ? +String(d).slice(0, 4) || null : null);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---------------- TMDB: films and TV ---------------- */
async function tmdb(env, f, path, params = {}) {
  if (!env.TMDB_TOKEN) throw new Error("TMDB_TOKEN isn't set");
  const u = new URL(`https://api.themoviedb.org/3${path}`);
  Object.entries(params).forEach(([k, v]) => v != null && v !== "" && u.searchParams.set(k, v));
  const r = await f(u, { headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, accept: "application/json" } });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}
const tmdbImg = (p, size = "w342") => (p ? `/img/tmdb/${size}${p}` : null);

export async function searchFilms(env, f, q, y) {
  const d = await tmdb(env, f, "/search/movie", { query: q, include_adult: "false", year: y });
  return d.results.slice(0, 10).map(m => ({ ref: String(m.id), title: m.title, year: year(m.release_date), poster: tmdbImg(m.poster_path, "w185"), sub: year(m.release_date) ?? "" }));
}
export async function filmDetails(env, f, tmdbId) {
  const m = await tmdb(env, f, `/movie/${tmdbId}`, { append_to_response: "credits" });
  return {
    tmdb: m.id, title: m.title, year: year(m.release_date), runtime: m.runtime || null, poster: tmdbImg(m.poster_path),
    directors: (m.credits?.crew || []).filter(c => c.job === "Director").map(c => c.name),
    cast: (m.credits?.cast || []).slice(0, 12).map(c => c.name),
    genres: (m.genres || []).map(g => g.name),
  };
}
/* Match an imported title like "The Thing" (1982) to TMDB */
export async function matchFilm(env, f, title, y) {
  let d = await tmdb(env, f, "/search/movie", { query: title, include_adult: "false", primary_release_year: y });
  if (!d.results.length) d = await tmdb(env, f, "/search/movie", { query: title, include_adult: "false" });
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const best = d.results.find(m => norm(m.title) === norm(title) && Math.abs((year(m.release_date) || 0) - y) <= 1)
    || d.results.find(m => Math.abs((year(m.release_date) || 0) - y) <= 1) || null;
  return best ? best.id : null;
}

export async function searchShows(env, f, q) {
  const d = await tmdb(env, f, "/search/tv", { query: q, include_adult: "false" });
  return d.results.slice(0, 10).map(s => ({ ref: String(s.id), title: s.name, year: year(s.first_air_date), poster: tmdbImg(s.poster_path, "w185"), sub: year(s.first_air_date) ?? "" }));
}
/* Fetch a show with every season's episodes. `existing` keeps your watched dates and ratings. */
export async function showDetails(env, f, tmdbId, existing = null, onlyChanged = false) {
  const s = await tmdb(env, f, `/tv/${tmdbId}`);
  const old = new Map((existing?.seasons || []).map(x => [x.n, x]));
  const seasons = [];
  for (const se of (s.seasons || []).filter(x => x.season_number > 0).sort((a, b) => a.season_number - b.season_number)) {
    const prev = old.get(se.season_number);
    const isLast = se.season_number === Math.max(...s.seasons.map(x => x.season_number));
    if (onlyChanged && prev && prev.episodes.length === se.episode_count && !isLast) { seasons.push(prev); continue; }
    if (f.left && f.left() < 2) { if (prev) seasons.push(prev); continue; }
    const d = await tmdb(env, f, `/tv/${tmdbId}/season/${se.season_number}`);
    const prevEps = new Map((prev?.episodes || []).map(e => [e.n, e]));
    seasons.push({
      n: se.season_number,
      episodes: (d.episodes || []).map(e => {
        const p = prevEps.get(e.episode_number) || {};
        return { n: e.episode_number, title: e.name || "", runtime: e.runtime || s.episode_run_time?.[0] || null, airdate: e.air_date || null, watched: p.watched ?? null, rating: p.rating ?? null };
      }),
    });
  }
  return {
    tmdb: s.id, title: s.name, year: year(s.first_air_date), poster: tmdbImg(s.poster_path),
    ongoing: !["Ended", "Canceled"].includes(s.status), network: s.networks?.[0]?.name || null,
    genres: (s.genres || []).map(g => g.name), seasons,
  };
}

/* ---------------- Open Library: books ---------------- */
export async function searchBooks(env, f, q) {
  const u = new URL("https://openlibrary.org/search.json");
  u.searchParams.set("q", q); u.searchParams.set("limit", "10");
  u.searchParams.set("fields", "key,title,author_name,first_publish_year,cover_i,number_of_pages_median,isbn");
  const r = await f(u, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`Open Library ${r.status}`);
  const d = await r.json();
  return d.docs.map(b => ({
    ref: b.key, title: b.title, sub: [b.author_name?.[0], b.first_publish_year].filter(Boolean).join(", "),
    authors: b.author_name || [], year: b.first_publish_year || null, cover: b.cover_i ? `/img/ol/${b.cover_i}` : null,
    pages: b.number_of_pages_median || null, isbn: b.isbn?.[0] || null,
  }));
}
/* Cover and page count for an imported book, by ISBN first, then title + author */
export async function bookExtras(env, f, book) {
  if (book.isbn && /^\d{10,13}$/.test(book.isbn)) {
    const r = await f(`https://openlibrary.org/isbn/${book.isbn}.json`, { headers: { "user-agent": UA } });
    if (r.ok) {
      const e = await r.json();
      if (e.covers?.[0] > 0) return { cover: `/img/ol/${e.covers[0]}`, pages: e.number_of_pages || null };
    }
  }
  const hits = await searchBooks(env, f, `${book.title} ${book.authors?.[0] || ""}`);
  const h = hits.find(x => x.cover) || hits[0];
  return h ? { cover: h.cover, pages: book.pages || h.pages } : null;
}

/* ---------------- Comic Vine: series, issues, covers ---------------- */
async function cv(env, f, path, params = {}) {
  if (!env.COMICVINE_KEY) throw new Error("COMICVINE_KEY isn't set");
  const u = new URL(`https://comicvine.gamespot.com/api${path}`);
  u.searchParams.set("api_key", env.COMICVINE_KEY); u.searchParams.set("format", "json");
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await f(u, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`Comic Vine ${r.status}`);
  const d = await r.json();
  if (d.status_code !== 1) throw new Error(`Comic Vine: ${d.error}`);
  return d;
}
const cvImg = img => {
  const url = img?.medium_url || img?.small_url || img?.original_url;
  const m = url && url.match(/^https:\/\/comicvine\.gamespot\.com\/a\/uploads\/(.+)$/);
  return m && !/6373148-blank/.test(url) ? `/img/cv/${m[1]}` : null;
};
const mtImg = url => { const m = url && String(url).match(/^https:\/\/static\.metron\.cloud\/(.+)$/); return m ? `/img/mt/${m[1]}` : null; };

/* "Captain America 2025" -> name "Captain America", year 2025 */
const splitYear = q => { const m = String(q).trim().match(/^(.*?)\s*\(?((?:19|20)\d{2})\)?$/); return m && m[1] ? { name: m[1], year: +m[2] } : { name: String(q).trim(), year: null }; };
export async function searchSeries(env, f, q) {
  const fields = "id,name,start_year,publisher,count_of_issues,image", { name, year } = splitYear(q);
  let d = await cv(env, f, "/volumes/", { filter: `name:${name}`, sort: "start_year:desc", limit: "100", field_list: fields });
  if (!d.results.length) d = await cv(env, f, "/search/", { resources: "volume", query: name, limit: "30", field_list: fields });
  return d.results.filter(v => v.count_of_issues > 0 && (!year || +v.start_year === year)).slice(0, 60).map(v => ({ ref: String(v.id), title: v.name, year: +v.start_year || null, sub: [v.publisher?.name, v.start_year, `${v.count_of_issues} issues`].filter(Boolean).join(", "), cover: cvImg(v.image) }));
}
/* Fetch a series and all its issues. `existing` keeps your read dates and ratings. */
export async function seriesDetails(env, f, cvId, existing = null) {
  const v = (await cv(env, f, `/volume/4050-${cvId}/`, { field_list: "id,name,start_year,publisher,image,count_of_issues" })).results;
  const issues = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    if (f.left && f.left() < 3) break;
    const d = await cv(env, f, "/issues/", { filter: `volume:${cvId}`, field_list: "id,issue_number,store_date,cover_date,image,name", limit: "100", offset: String(offset) });
    issues.push(...d.results);
    if (d.results.length < 100) break;
  }
  const prev = new Map((existing?.issues || []).map(i => [String(i.n), i]));
  const merged = issues.map(i => {
    const p = prev.get(String(i.issue_number)) || {};
    return { n: String(i.issue_number), title: i.name || "", released: i.store_date || i.cover_date || p.released || null, cover: cvImg(i.image) || p.cover || null, read: p.read ?? null, rating: p.rating ?? null, cv: i.id };
  });
  for (const [n, p] of prev) if (!merged.some(i => i.n === n)) merged.push(p);  // keep upcoming issues Comic Vine doesn't list yet
  merged.sort(issueOrder);
  const last = merged.filter(i => i.released && i.released <= today()).at(-1);
  const recent = last && (Date.now() - new Date(last.released)) / 864e5 < 150;
  return {
    cv: v.id, name: v.name.replace(/\s+\(\d{4}\)$/, ""), start: +v.start_year || null, publisher: v.publisher?.name || "",
    cover: cvImg(v.image), issues: merged, ongoing: !!recent || merged.some(i => i.released > today()),
    end: recent ? null : year(last?.released),
  };
}
export function issueOrder(a, b) {
  const p = s => { const m = String(s.n).match(/^(-?\d+)(?:\.(\d+))?/); return m ? [+m[1], +(m[2] || 0)] : [1e6, 0]; };
  const x = p(a), y = p(b);
  return x[0] - y[0] || x[1] - y[1];
}

/* ---------------- Metron: upcoming releases ---------------- */
async function metron(env, f, path, params = {}) {
  if (!env.METRON_USER || !env.METRON_PASS) throw new Error("Metron credentials aren't set");
  const u = new URL(`https://metron.cloud/api${path}`);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await f(u, { headers: { authorization: `Basic ${btoa(`${env.METRON_USER}:${env.METRON_PASS}`)}`, "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`Metron ${r.status}`);
  return r.json();
}
/* Metron series search, newest runs first. refs look like "mt:123" */
export async function searchSeriesMetron(env, f, q) {
  const { name, year } = splitYear(q);
  const d = await metron(env, f, "/series/", { name, ...(year ? { year_began: year } : {}) });
  return (d.results || []).sort((a, b) => (b.year_began || 0) - (a.year_began || 0)).slice(0, 60).map(s => ({
    ref: `mt:${s.id}`, title: String(s.series || s.name || "").replace(/\s+\(\d{4}\)$/, ""), year: s.year_began || null,
    sub: [s.year_began, s.volume ? `vol. ${s.volume}` : "", s.issue_count != null ? `${s.issue_count} issues` : ""].filter(Boolean).join(", "), cover: null,
  }));
}
/* A Metron series with every issue (store dates, covers). `existing` keeps your read dates and ratings. */
export async function seriesDetailsMetron(env, f, id, existing = null) {
  const s = await metron(env, f, `/series/${id}/`);
  const issues = [];
  let page = 1;
  while (page < 40) {
    if (f.left && f.left() < 2) break;
    const d = await metron(env, f, "/issue/", { series_id: id, page });
    issues.push(...(d.results || []));
    if (!d.next) break;
    page++;
  }
  const prev = new Map((existing?.issues || []).map(i => [String(i.n), i]));
  const merged = issues.map(i => { const p = prev.get(String(i.number)) || {}; return { n: String(i.number), title: "", released: i.store_date || i.cover_date || p.released || null, cover: mtImg(i.image) || p.cover || null, read: p.read ?? null, rating: p.rating ?? null }; });
  for (const [n, p] of prev) if (!merged.some(i => i.n === n)) merged.push(p);
  merged.sort(issueOrder);
  const last = merged.filter(i => i.released && i.released <= today()).at(-1);
  const recent = last && (Date.now() - new Date(last.released)) / 864e5 < 150;
  return {
    metron: s.id, name: String(s.name || s.series || "").replace(/\s+\(\d{4}\)$/, ""), volume: s.volume > 1 ? s.volume : null, start: s.year_began || null,
    publisher: s.publisher?.name || "", cover: merged.find(i => i.cover)?.cover || null, issues: merged,
    ongoing: !s.year_end || !!recent || merged.some(i => i.released > today()), end: s.year_end || null,
  };
}

/* Issues of a series with a store date after today. Returns [{n, released}] */
export async function upcomingIssues(env, f, series) {
  let id = series.metron;
  if (!id) {
    const d = await metron(env, f, "/series/", { name: series.name, ...(series.start ? { year_began: series.start } : {}) });
    id = d.results?.[0]?.id;
    if (!id) return { metron: null, issues: [] };
  }
  const d = await metron(env, f, "/issue/", { series_id: id, store_date_range_after: today() });
  return { metron: id, issues: (d.results || []).map(i => ({ n: String(i.number), released: i.store_date || i.cover_date, cover: mtImg(i.image) })) };
}

export const ids = { film: t => `tmdb-${t}`, show: t => `tv-${t}`, series: c => (String(c).startsWith("mt:") ? `mt-${String(c).slice(3)}` : `cv-${c}`), book: (title, ref) => slug(title) || slug(ref) };
