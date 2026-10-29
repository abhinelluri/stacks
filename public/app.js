"use strict";

/* ================= helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const day = s => new Date(s + "T12:00:00");
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
const YEAR = String(new Date().getFullYear());
const shortDate = s => { const d = day(s); return `${MONTHS[d.getMonth()].slice(0,3)} ${d.getDate()}`; };
const longDate = s => { const d = day(s); return `${MONTHS[d.getMonth()].slice(0,3)} ${d.getDate()}, ${d.getFullYear()}`; };
const starText = r => `${"★".repeat(Math.floor(r))}${r % 1 ? "½" : ""}`;
const stars = r => r == null ? `<span class="stars dim">unrated</span>` : `<span class="stars" aria-label="${r} stars">${starText(r)}</span>`;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : "";
const hm = m => !m ? "" : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;
const uid = () => Math.random().toString(36).slice(2, 9);

const VENUE = { home: "Home", theater: "Theater", tv: "TV" };
const LABEL = { film: "Film", tv: "TV", book: "Book", comic: "Comic" };
const PLURAL = { film: "Films", tv: "TV", book: "Books", comic: "Comics" };
const FORMATS = [["paperback","Paperback"],["hardcover","Hardcover"],["ebook","Ebook"],["audiobook","Audiobook"]];
const STATUS = {
  book:  [["reading","Reading"],["want","Want to read"],["paused","Paused"],["read","Finished"],["dnf","DNF"]],
  comic: [["reading","Reading"],["want","Want to read"],["paused","Paused"],["caught","Caught up"],["finished","Finished"],["dropped","Dropped"]],
  tv:    [["watching","Watching"],["want","Want to watch"],["paused","Paused"],["caught","Caught up"],["finished","Finished"],["dropped","Dropped"]],
};
const VERB = {
  book:  { reading: "Started reading", reread: "Started a reread", want: "Added to want to read", paused: "Paused", read: "Finished", dnf: "DNF" },
  comic: { reading: "Started reading", want: "Added to want to read", paused: "Paused", caught: "Caught up", finished: "Finished the run", dropped: "Dropped" },
  tv:    { watching: "Started watching", want: "Added to want to watch", paused: "Paused", caught: "Caught up", finished: "Finished", dropped: "Dropped" },
};
const FILTER_DEFAULT = { venue: "all", liked: false, rewatch: false, notes: false, rating: "any", decade: "any", q: "", director: "", actor: "", genre: "" };

let D, films, log = null, sel = null, bookUnit = null;
const state = { filmTab: "diary", f: { ...FILTER_DEFAULT }, moreOpen: false, tab: { book: "reading", comic: "reading", tv: "watching" }, comicView: "shelves", topCat: "film", topScope: "all", shelfPick: null };

const items = k => k === "book" ? D.books : k === "comic" ? D.series : k === "tv" ? D.shows : D.films;
const find = (k, id) => items(k).find(x => x.id === id);
const nameOf = (k, x) => k === "comic" ? `${x.name}${x.volume ? ` vol. ${x.volume}` : ""}` : x.title;
const subOf = (k, x) => k === "book" ? x.authors.join(", ") : k === "comic" ? `${x.publisher}, ${x.start}${x.ongoing ? " to now" : x.end && x.end !== x.start ? `–${x.end}` : ""}` : `${x.year ?? ""}`;
const artOf = (k, x) => k === "film" || k === "tv" ? x.poster : x.cover;

/* units = issues (comics) or episodes (TV); not released yet = not "out" */
function units(k, x) {
  if (k === "comic") return x.issues.map((i, n) => ({ ref: i, key: String(n), label: `#${i.n}`, done: i.read != null, when: i.read, out: !i.released || i.released <= today() }));
  return x.seasons.flatMap(s => s.episodes.map(e => ({ ref: e, key: `${s.n}:${e.n}`, label: `S${s.n}E${e.n}`, season: s.n, done: e.watched != null, when: e.watched, out: !e.airdate || e.airdate <= today() })));
}
function progress(k, x) {
  const u = units(k, x).filter(i => i.out), done = u.filter(i => i.done).length, last = u.map(i => i.done).lastIndexOf(true);
  return { done, total: u.length, next: u.find((i, n) => !i.done && n > last) || u.find(i => !i.done) };
}
const seasonRating = s => { const r = s.episodes.filter(e => e.rating != null).map(e => e.rating); return r.length ? Math.round(avg(r) * 2) / 2 : null; };
const showRating = x => { const r = x.seasons.map(seasonRating).filter(v => v != null); return r.length ? Math.round(avg(r) * 2) / 2 : null; };
function setStatus(k, x, s, d = today()) { x.status = s; x.history.push({ s, d }); }
function autoStatus(k, x) {
  const p = progress(k, x), act = k === "tv" ? "watching" : "reading";
  if (!p.next && p.total) { const s = x.ongoing ? "caught" : "finished"; if (x.status !== s) setStatus(k, x, s); }
  else if (p.done && x.status !== act) setStatus(k, x, act);
}

/* books: reads (incl. rereads), each with dated progress sessions in pages, chapters or audiobook minutes */
const curRead = b => b.reads.find(r => !r.end);
const unitOf = b => b.format === "audiobook" ? "time" : "page";
const totalFor = (b, u) => u === "page" ? b.pages : u === "chapter" ? b.chapters : b.minutes;
function bookPct(b) { const s = curRead(b)?.sessions.at(-1); if (!s) return null; const t = totalFor(b, s.unit); return t ? Math.min(100, Math.round(s.at / t * 100)) : null; }
const atLabel = (b, s) => { const t = totalFor(b, s.unit); return s.unit === "time" ? `${hm(s.at)}${t ? ` of ${hm(t)}` : ""}` : `${cap(s.unit)} ${s.at}${t ? ` of ${t}` : ""}`; };
function setBookStatus(b, s, d = today(), opts = {}) {
  let r = curRead(b);
  if (["reading", "paused", "read", "dnf"].includes(s) && !r) { r = { start: d, end: null, outcome: null, rating: null, sessions: [] }; b.reads.push(r); }
  if (s === "read" || s === "dnf") { r.end = d; r.outcome = s; if (s === "read") { r.rating = opts.rating ?? null; if (r.rating != null) b.rating = r.rating; } }
  b.status = s; b.history.push({ s: opts.reread ? "reread" : s, d });
}
function bookDays(b) {
  const out = [];
  b.reads.forEach(r => { const last = {}; r.sessions.forEach(s => { out.push({ d: s.d, unit: s.unit, amt: Math.max(0, s.at - (last[s.unit] ?? 0)), at: s.at }); last[s.unit] = s.at; }); });
  return out;
}

const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function cover(k, title, sub, opts = {}) {
  const shade = [0, 14, 28, 40][hash(title) % 4], fs = title.length > 34 ? 16 : title.length > 18 ? 19 : 23;
  const shown = opts.thumb ? title.replace(/^(The|A|An) /, "")[0] : title;
  return `<div class="cover c-${k}${opts.thumb ? " thumb" : ""}" style="--shade:${shade}%;--fs:${fs}px" aria-hidden="true"><b>${esc(shown)}</b><span>${esc(sub ?? "")}</span>${opts.img ? `<img src="${esc(opts.img)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</div>`;
}
const starPick = (id, val) => `<div class="star-pick" id="${id}">${[1,2,3,4,5].map(i => `<button type="button" data-s="${i}" class="${(val || 0) >= i ? "full" : ""}" aria-label="${i} stars">★${val === i - 0.5 ? `<span class="h">★</span>` : ""}</button>`).join("")}</div>`;
function bindStars(id, get, set, rerender) {
  $$(`#${id} button`).forEach(b => b.onclick = e => { const i = +b.dataset.s, v = e.detail > 0 && e.offsetX < b.clientWidth / 2 ? i - 0.5 : i; set(get() === v ? null : v); rerender(); });
}

/* ================= HOME ================= */
function activity() {
  return [
    ...D.watches.map(w => ({ k: "film", d: w.date, r: w.rating, t: films[w.film].title, sub: `${films[w.film].year}${w.venue === "theater" ? ", in theater" : w.rewatch ? ", rewatch" : ""}` })),
    ...D.shows.flatMap(x => units("tv", x).filter(u => u.when).map(u => ({ k: "tv", d: u.when, r: u.ref.rating, t: x.title, sub: u.label }))),
    ...D.series.flatMap(x => units("comic", x).filter(u => u.when).map(u => ({ k: "comic", d: u.when, r: u.ref.rating, t: `${x.name} ${u.label}`, sub: "" }))),
    ...D.books.flatMap(b => b.reads.filter(r => r.end && r.outcome === "read").map(r => ({ k: "book", d: r.end, r: r.rating, t: b.title, sub: b.authors[0], wide: true }))),
  ];
}
function shelfSVG(width) {
  const ev = activity().filter(e => e.d.startsWith(YEAR)).sort((a, b) => a.d.localeCompare(b.d));
  const slots = ev.reduce((n, e) => n + (e.wide ? 3 : 1), 0) || 1;
  const sp = Math.max(4, Math.floor(width / slots)), H = 150, base = H - 22;
  let x = 0, months = new Set(), out = "", lastLabel = -99;
  ev.forEach((e, i) => {
    const w = (e.wide ? 3 : 1) * sp - 1, h = 8 + ((e.r ?? 2.5) / 5) * (base - 12);
    const m = day(e.d).getMonth();
    if (!months.has(m)) { months.add(m); if (x - lastLabel > 34) { out += `<text x="${x}" y="${H - 4}">${MONTHS[m].slice(0,3)}</text>`; lastLabel = x; } }
    out += `<rect data-i="${i}" class="sp-${e.k}${state.shelfPick === i ? " on" : ""}" x="${x}" y="${base - h}" width="${w}" height="${h}" rx="0.6"><title>${esc(e.t)}</title></rect>`;
    x += w + 1;
  });
  return { svg: `<svg class="shelf" width="${x}" height="${H}" viewBox="0 0 ${x} ${H}" role="img" aria-label="Everything you logged this year as spines on a shelf, colored by type, taller means higher rated">${out}</svg>`, ev };
}
function item(k, x, side, pct) {
  return `<button class="now-item c-${k}" data-open="${k}:${esc(x.id)}">${cover(k, nameOf(k, x), "", { thumb: true, img: artOf(k, x) })}<span><h4>${esc(nameOf(k, x))}</h4><p>${esc(subOf(k, x))}</p>${pct != null ? `<div class="meter"><i style="width:${pct}%"></i></div>` : ""}</span><span class="side">${side}</span></button>`;
}
function renderHome() {
  const fy = D.watches.filter(w => w.date.startsWith(YEAR));
  const eps = D.shows.reduce((n, x) => n + units("tv", x).filter(u => u.when?.startsWith(YEAR)).length, 0);
  const booksRead = D.books.reduce((n, b) => n + b.reads.filter(r => r.outcome === "read" && r.end?.startsWith(YEAR)).length, 0);
  const issues = D.series.reduce((n, x) => n + units("comic", x).filter(u => u.when?.startsWith(YEAR)).length, 0);
  const group = (k, list, empty) => `<div class="group c-${k}"><h3>${PLURAL[k]} <small>${list.length || ""}</small></h3>${list.length ? list.join("") : `<p class="quiet">${empty}</p>`}</div>`;
  const nextSide = (k, x) => { const p = progress(k, x); return `${p.done} of ${p.total}<br>next <b>${esc(p.next?.label ?? "")}</b>`; };
  const tvItems = D.shows.filter(x => x.status === "watching").map(x => item("tv", x, nextSide("tv", x)));
  const bookItems = D.books.filter(b => b.status === "reading").map(b => { const pct = bookPct(b), s = curRead(b)?.sessions.at(-1);
    return item("book", b, s ? `${pct != null ? `${pct}%` : atLabel(b, s)}<br>${shortDate(s.d)}` : `${FORMATS.find(f => f[0] === b.format)?.[1] ?? ""}<br>since ${shortDate(curRead(b)?.start ?? today())}`, pct); });
  const comicItems = D.series.filter(x => x.status === "reading").map(x => item("comic", x, nextSide("comic", x)));
  const feed = activity().sort((a, b) => b.d.localeCompare(a.d)).slice(0, 10);

  $("#app").innerHTML = `
  <div class="view">
    <section class="year">
      <div class="year-head">
        <h1 class="num">${YEAR}</h1>
        <p><b>${fy.length} films</b>, ${fy.filter(w => w.venue === "theater").length} of them in theaters. <b>${eps} episodes</b> of TV. <b>${booksRead} books</b> finished. <b>${issues} comic issues</b> read.</p>
      </div>
      <div class="shelf-scroll" id="shelf-scroll"></div>
      <div class="shelf-foot">
        ${["film","tv","book","comic"].map(k => `<span class="key"><i style="background:var(--${k})"></i>${PLURAL[k]}</span>`).join("")}
        <span class="shelf-pick" id="shelf-pick">Taller spine, higher rating. Tap one.</span>
      </div>
    </section>
    <div class="cols">
      <section class="block">
        <div class="block-head"><h2>Current</h2></div>
        ${group("tv", tvItems, "No shows in progress.")}
        ${group("book", bookItems, "No books in progress.")}
        ${group("comic", comicItems, "No comic runs in progress.")}
      </section>
      <section class="block">
        <div class="block-head"><h2>Recently</h2><a href="#films">Full diary</a></div>
        <ul class="feed">${feed.map(f => `<li><span class="d num">${shortDate(f.d)}</span><span class="t"><b>${esc(f.t)}</b> <span>${esc(f.sub)}</span><span class="kind c-${f.k}">${LABEL[f.k]}</span></span>${f.r != null ? stars(f.r) : "<span></span>"}</li>`).join("")}</ul>
      </section>
    </div>
  </div>`;
  drawShelf();
}
function drawShelf() {
  const box = $("#shelf-scroll"); if (!box) return;
  const { svg, ev } = shelfSVG(box.clientWidth);
  box.innerHTML = svg; box.scrollLeft = box.scrollWidth;
  box.onclick = e => {
    const i = e.target.dataset?.i; if (i == null) return;
    state.shelfPick = +i; const x = ev[i];
    $$("rect.on", box).forEach(r => r.classList.remove("on")); e.target.classList.add("on");
    $("#shelf-pick").innerHTML = `${LABEL[x.k]}: ${esc(x.t)}${x.k === "tv" ? ` ${esc(x.sub)}` : ""}, ${shortDate(x.d)} ${x.r != null ? stars(x.r) : ""}`;
  };
}

/* ================= FILMS ================= */
const RATING_F = { any: ["Any rating", () => true], "5": ["5 stars", r => r === 5], "4.5": ["4½ and up", r => r >= 4.5], "4": ["4 and up", r => r >= 4], "3": ["3 and up", r => r >= 3], low: ["Below 3", r => r != null && r < 3], none: ["Unrated", r => r == null] };
function filteredWatches() {
  const f = state.f, q = f.q.trim().toLowerCase(), has = (arr, s) => !s || arr.some(v => v.toLowerCase().includes(s.toLowerCase()));
  return D.watches.filter(w => { const m = films[w.film];
    return (f.venue === "all" || w.venue === f.venue) && (!f.liked || m.liked) && (!f.rewatch || w.rewatch) && (!f.notes || w.review)
      && RATING_F[f.rating][1](w.rating) && (f.decade === "any" || Math.floor(m.year / 10) * 10 == f.decade)
      && (!q || m.title.toLowerCase().includes(q)) && has(m.directors, f.director) && has(m.cast, f.actor) && has(m.genres, f.genre); });
}
function renderFilms() {
  const rated = D.watches.filter(w => w.rating != null).map(w => w.rating), f = state.f;
  let body;
  if (state.filmTab === "watchlist") {
    body = D.watchlist.length ? `<div class="grid">${D.watchlist.map(w => `<button class="tile" data-wl="${esc(w.id)}">${cover("film", w.title, w.year, { img: w.poster })}<span class="t">${esc(w.title)}</span><p>${w.year}, added ${shortDate(w.added)}</p></button>`).join("")}</div>`
      : `<div class="empty"><b>Nothing on your watchlist</b><p>Use + and choose "Want to watch" to add a film, or tap "Add to watchlist" on any film's page. Letterboxd's watchlist file can be imported too.</p></div>`;
  } else {
    const list = filteredWatches(), groups = {};
    list.forEach(w => { const k = w.date.slice(0, 7); (groups[k] ||= []).push(w); });
    const decades = [...new Set(D.films.map(m => Math.floor(m.year / 10) * 10))].sort();
    const matched = D.films.some(m => m.directors.length);
    const active = Object.entries(f).some(([k, v]) => v !== FILTER_DEFAULT[k]);
    body = `
      <div class="controls">
        ${[["all","All"],["theater","Theater"],["home","Home"],["tv","TV"]].map(([k, l]) => `<button class="chip" data-venue="${k}" aria-pressed="${f.venue === k}">${l}</button>`).join("")}
        <button class="chip" data-flag="liked" aria-pressed="${f.liked}"><span class="heart">♥</span> Liked</button>
        <button class="chip" data-flag="rewatch" aria-pressed="${f.rewatch}">Rewatches</button>
        <button class="chip" data-flag="notes" aria-pressed="${f.notes}">With notes</button>
      </div>
      <div class="controls">
        <select class="sel" id="f-rating" aria-label="Rating">${Object.entries(RATING_F).map(([k, [l]]) => `<option value="${k}" ${f.rating === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select class="sel" id="f-decade" aria-label="Release decade"><option value="any">Any decade</option>${decades.map(d => `<option value="${d}" ${f.decade == d ? "selected" : ""}>${d}s</option>`).join("")}</select>
        <input class="search" id="f-q" type="search" placeholder="Find a title" value="${esc(f.q)}" aria-label="Find a title">
        <button class="linkish" id="f-more">${state.moreOpen ? "Hide people and genres" : "Director, actor, genre"}</button>
        ${active ? `<button class="linkish" id="f-clear">Clear filters</button>` : ""}
      </div>
      ${state.moreOpen ? `<div class="more"><div class="more-grid">
        ${[["director","Director"],["actor","Actor"],["genre","Genre"]].map(([k, l]) => `<label class="field"><span>${l}</span><input id="f-${k}" value="${esc(f[k])}" ${matched ? "" : "disabled"} placeholder="${matched ? `Any ${l.toLowerCase()}` : "Needs TMDB"}"></label>`).join("")}
      </div>${matched ? "" : `<p class="hint">These work once your films are matched to TMDB in the next phase.</p>`}</div>` : ""}
      <p class="note">${list.length === D.watches.length ? `${list.length} entries` : `${list.length} of ${D.watches.length} entries match`}</p>
      ${Object.entries(groups).map(([k, ws]) => `
      <section class="month">
        <h2>${MONTHS[+k.slice(5) - 1]} ${k.slice(0, 4)} <small>${ws.length} film${ws.length > 1 ? "s" : ""}</small></h2>
        ${ws.map(w => { const m = films[w.film], d = day(w.date); return `
          <button class="entry" data-film="${esc(m.id)}">
            <span class="day num">${d.getDate()}<small>${DOW[d.getDay()]}</small></span>
            ${cover("film", m.title, "", { thumb: true, img: m.poster })}
            <span class="info"><b>${esc(m.title)}</b>${m.liked ? ` <span class="heart" aria-label="liked">♥</span>` : ""}<span class="meta"><span>${m.year}</span>${w.venue !== "home" ? `<span class="venue ${w.venue}">${VENUE[w.venue]}</span>` : ""}${w.rewatch ? "<span>Rewatch</span>" : ""}${w.review ? "<span>Notes</span>" : ""}</span></span>
            ${stars(w.rating)}
          </button>`; }).join("")}
      </section>`).join("")}`;
  }
  $("#app").innerHTML = `
  <div class="view">
    <div class="page-head">
      <h1>Films</h1>
      <div class="summary">
        <span><b class="num">${D.watches.length}</b>logged</span>
        <span><b class="num">${D.watches.filter(w => w.venue === "theater").length}</b>in theaters</span>
        <span><b class="num">${D.watches.filter(w => w.rewatch).length}</b>rewatches</span>
        <span><b class="num">${avg(rated).toFixed(2)}</b>average rating</span>
      </div>
      <div class="views" role="group">${[["diary","Diary"],["watchlist",`Watchlist ${D.watchlist.length || ""}`]].map(([k, l]) => `<button data-ft="${k}" aria-pressed="${state.filmTab === k}">${l}</button>`).join("")}</div>
    </div>
    ${body}
  </div>`;
  const re = () => renderFilms();
  $$("[data-ft]").forEach(b => b.onclick = () => { state.filmTab = b.dataset.ft; re(); });
  $$("[data-venue]").forEach(b => b.onclick = () => { f.venue = b.dataset.venue; re(); });
  $$("[data-flag]").forEach(b => b.onclick = () => { f[b.dataset.flag] = !f[b.dataset.flag]; re(); });
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  on("#f-rating", "onchange", e => { f.rating = e.target.value; re(); });
  on("#f-decade", "onchange", e => { f.decade = e.target.value; re(); });
  on("#f-more", "onclick", () => { state.moreOpen = !state.moreOpen; re(); });
  on("#f-clear", "onclick", () => { state.f = { ...FILTER_DEFAULT }; re(); });
  ["q", "director", "actor", "genre"].forEach(k => on(`#f-${k}`, "oninput", e => { f[k] = e.target.value; const p = e.target.selectionStart; re(); const n = $(`#f-${k}`); n.focus(); n.setSelectionRange(p, p); }));
  $$("[data-film]").forEach(b => b.onclick = () => openFilm(b.dataset.film));
  $$("[data-wl]").forEach(b => b.onclick = () => openFilm(b.dataset.wl));
}

/* film page: poster + metadata, like, watchlist, every watch with edit and delete */
function openFilm(id) {
  const m = films[id] || D.watchlist.find(w => w.id === id); if (!m) return;
  const ws = D.watches.filter(w => w.film === id), onWl = D.watchlist.some(w => w.id === id), meta = films[id] ? m : { directors: [], cast: [], genres: [] };
  sheet(`
    <div class="sheet-head"><span class="kind c-film">Film</span><button class="x" data-close>Close</button></div>
    <div class="detail-top">${cover("film", m.title, m.year, { img: m.poster })}
      <div><h2>${esc(m.title)}</h2><p>${m.year}${meta.runtime ? `, ${meta.runtime} min` : ""}${meta.directors.length ? `, ${esc(meta.directors.join(", "))}` : ""}</p>
      ${meta.genres.length ? `<p>${esc(meta.genres.join(", "))}</p>` : ""}
      ${ws.length ? `<p>Your rating ${stars(m.rating)}</p>` : ""}</div>
    </div>
    <div class="controls">
      ${films[id] ? `<button class="toggle" id="like" aria-pressed="${m.liked}">♥ ${m.liked ? "Liked" : "Like"}</button>` : ""}
      <button class="toggle plain" id="wl" aria-pressed="${onWl}">${onWl ? "On watchlist" : "Add to watchlist"}</button>
      ${films[id] ? `<button class="chip" id="again">${ws.length ? "Log a rewatch" : "Log it"}</button>` : ""}
    </div>
    ${ws.length ? `<div class="field"><span>Watched ${ws.length} time${ws.length === 1 ? "" : "s"}</span>
      <ul class="timeline">${ws.map(w => `<li><span class="num">${longDate(w.date)}</span><span>${VENUE[w.venue]}${w.rewatch ? ", rewatch" : ""} ${stars(w.rating)}</span><button class="linkish" data-edit="${w.id}">Edit</button>${w.review ? `<p class="rv">${esc(w.review)}</p>` : ""}</li>`).join("")}</ul></div>` : ""}
    ${meta.cast.length ? `<div class="field"><span>Cast</span><p style="margin:0">${esc(meta.cast.slice(0, 8).join(", "))}</p></div>` : `<p class="hint">Poster, runtime, director, cast and genres come from TMDB in the next phase.</p>`}
  `, el => {
    const re = () => openFilm(id);
    $("#like", el) && ($("#like", el).onclick = () => { m.liked = !m.liked; re(); });
    $("#wl", el).onclick = () => { if (onWl) D.watchlist = D.watchlist.filter(w => w.id !== id); else D.watchlist.unshift({ id, title: m.title, year: m.year, added: today(), poster: m.poster, tmdb: m.tmdb ?? null }); re(); };
    $("#again", el) && ($("#again", el).onclick = () => openLog({ kind: "film", pick: id, title: m.title }));
    $$("[data-edit]", el).forEach(b => b.onclick = () => openLog({ edit: D.watches.find(w => w.id === b.dataset.edit) }));
  });
}

/* ================= TV / BOOKS / COMICS ================= */
const EMPTY = {
  book: { reading: "No books in progress.", want: "Books you want to read collect here, dated when you add them.", paused: "Nothing paused.", read: "Finished books, with dates and ratings.", dnf: "Books you stopped partway through still count in your history." },
  comic: { reading: "No runs in progress.", want: "Series you want to start, dated when you add them.", paused: "Nothing paused.", caught: "Ongoing series where you've read everything out so far. A new issue moves them back to Reading.", finished: "Completed runs.", dropped: "Series you've stopped following." },
  tv: { watching: "Shows you're in the middle of, with your next episode.", want: "Shows you want to start.", paused: "Nothing paused.", caught: "Shows you're current on. A new episode moves them back to Watching.", finished: "Shows you've seen to the end.", dropped: "Shows you gave up on." },
};
function renderShelfPage(k) {
  const all = items(k);
  let summary = "", top = "", body;
  if (k === "book") {
    const days = D.books.flatMap(bookDays);
    summary = `<span><b class="num">${D.books.reduce((n, b) => n + b.reads.filter(r => r.outcome === "read").length, 0)}</b>finished</span><span><b class="num">${days.filter(d => d.unit === "page").reduce((n, d) => n + d.amt, 0)}</b>pages logged</span><span><b class="num">${hm(days.filter(d => d.unit === "time").reduce((n, d) => n + d.amt, 0)) || "0h"}</b>listened</span>`;
  }
  if (k === "tv") summary = `<span><b class="num">${all.reduce((n, x) => n + progress(k, x).done, 0)}</b>episodes</span><span><b class="num">${all.length}</b>shows</span>`;
  if (k === "comic") {
    summary = `<span><b class="num">${all.reduce((n, x) => n + progress(k, x).done, 0)}</b>issues read</span><span><b class="num">${all.length}</b>series</span><span><b class="num">${upcoming().length}</b>coming up</span>`;
    top = `<div class="views" role="group">${[["shelves","My comics"],["upcoming","Upcoming"]].map(([v, l]) => `<button data-cv="${v}" aria-pressed="${state.comicView === v}">${l}</button>`).join("")}</div>`;
  }
  const chips = `<div class="status-row" role="group" aria-label="Status">${STATUS[k].map(([s, l]) => `<button class="chip" data-st="${s}" aria-pressed="${state.tab[k] === s}">${l}<span class="n">${all.filter(x => x.status === s).length}</span></button>`).join("")}</div>`;
  if (k === "comic" && state.comicView === "upcoming") body = renderUpcoming();
  else {
    const list = all.filter(x => x.status === state.tab[k]);
    if (!all.length) body = chips + (k === "tv"
      ? `<div class="empty"><b>No shows yet</b><p>Use + to search for a show. Seasons, episodes, runtimes and posters fill in from TMDB, and each episode you mark keeps its date and rating.</p></div>`
      : `<div class="empty"><b>Starting fresh</b><p>Use + to search for a series. Every issue, cover and release date fills in from Comic Vine, and new issues are added automatically as they come out.</p></div>`);
    else if (!list.length) body = chips + `<div class="empty"><p>${EMPTY[k][state.tab[k]]}</p></div>`;
    else if (k === "book") body = chips + `<div class="grid">${list.map(b => { const last = b.history.at(-1), pct = b.status === "reading" ? bookPct(b) : null, n = b.reads.filter(r => r.outcome === "read").length; return `
      <button class="tile c-book" data-open="book:${esc(b.id)}">${cover("book", b.title, b.authors[0], { img: b.cover })}<span class="t">${esc(b.title)}</span>
      ${pct != null ? `<div class="meter"><i style="width:${pct}%"></i></div>` : ""}
      ${b.status === "read" ? stars(b.rating) : ""}<p>${b.format === "audiobook" ? "Audiobook. " : ""}${last ? `${VERB.book[last.s]} ${shortDate(last.d)}` : ""}${n > 1 ? `. Read ${n} times` : ""}</p></button>`; }).join("")}</div>`;
    else body = chips + `<div class="rows">${list.map(x => { const p = progress(k, x), r = k === "tv" ? showRating(x) : null; return `
      <button class="row c-${k}" data-open="${k}:${esc(x.id)}">${cover(k, nameOf(k, x), "", { thumb: true, img: artOf(k, x) })}
        <span><b>${esc(nameOf(k, x))}</b> <span class="sub">${esc(subOf(k, x))}</span></span>
        <span class="count num">${p.done}/${p.total}${p.next ? `, next ${esc(p.next.label)}` : ""}${r != null ? ` ${stars(r)}` : ""}</span>
        <span class="cells" aria-hidden="true">${units(k, x).slice(0, 160).map(u => `<i class="${u.done ? "r" : u.out ? "" : "f"}"></i>`).join("")}</span>
      </button>`; }).join("")}</div>`;
  }
  $("#app").innerHTML = `<div class="view"><div class="page-head"><h1>${PLURAL[k]}</h1><div class="summary">${summary}</div>${top}</div>${body}</div>`;
  $$("[data-st]").forEach(b => b.onclick = () => { state.tab[k] = b.dataset.st; renderShelfPage(k); });
  $$("[data-cv]").forEach(b => b.onclick = () => { state.comicView = b.dataset.cv; renderShelfPage(k); });
}
function upcoming() {
  return D.series.filter(x => ["reading", "caught", "paused"].includes(x.status))
    .flatMap(x => x.issues.filter(i => i.released && i.released > today()).map(i => ({ x, i }))).sort((a, b) => a.i.released.localeCompare(b.i.released));
}
function renderUpcoming() {
  const up = upcoming();
  if (!up.length) return `<div class="empty"><b>Nothing scheduled yet</b><p>New issues for every series you're reading or caught up on show here by release week, with covers, as soon as they're announced. On release day they also land in the series automatically.</p></div>`;
  const weeks = {};
  up.forEach(u => { const d = day(u.i.released); d.setDate(d.getDate() - ((d.getDay() + 4) % 7)); (weeks[iso(d)] ||= []).push(u); });
  return Object.entries(weeks).map(([w, us]) => `<section class="week"><h2>Week of ${shortDate(w)}</h2>${us.map(({ x, i }) => `<button class="row c-comic" data-open="comic:${esc(x.id)}">${cover("comic", x.name, "", { thumb: true, img: i.cover })}<span><b>${esc(nameOf("comic", x))} #${esc(i.n)}</b> <span class="sub">${esc(x.publisher)}</span></span><span class="count">${shortDate(i.released)}</span></button>`).join("")}</section>`).join("");
}

/* detail sheet for books, shows and series */
const unitBtn = u => `<button class="${u.done ? "r" : ""}${sel === u.key ? " sel" : ""}" data-u="${u.key}" ${u.out ? "" : "disabled"}>${esc(u.label.replace(/^S\d+/, ""))}${u.when ? `<small>${shortDate(u.when)}</small>` : !u.out ? `<small>${shortDate(u.ref.released || u.ref.airdate)}</small>` : ""}${u.ref.rating != null ? `<small>${starText(u.ref.rating)}</small>` : ""}</button>`;
function openDetail(k, id) {
  if (k === "film") return openFilm(id);
  const x = find(k, id); if (!x) return;
  let mid = "";
  if (k === "book") mid = bookBody(x);
  else {
    const p = progress(k, x), us = units(k, x), s = sel && us.find(u => u.key === sel), noun = k === "tv" ? "episode" : "issue";
    const grid = k === "tv"
      ? x.seasons.map(se => `<div class="field"><span>Season ${se.n}${seasonRating(se) != null ? ` ${stars(seasonRating(se))}` : ""}</span><div class="unit-grid c-tv">${us.filter(u => u.season === se.n).map(unitBtn).join("")}</div></div>`).join("")
      : `<div class="unit-grid c-comic">${us.map(unitBtn).join("")}</div>`;
    mid = `<p class="hint">${p.done} of ${p.total} ${noun}s ${k === "tv" ? "watched" : "read"}${p.next ? `, next ${p.next.label}` : ""}. Tap one to mark it, date it, rate it, or mark everything up to it.</p>${grid}
      ${s ? `<div class="editor"><b>${esc(s.label)}${s.ref.title ? ` ${esc(s.ref.title)}` : ""}</b>
        <div class="controls"><button class="toggle plain" id="u-done" aria-pressed="${s.done}">${s.done ? (k === "tv" ? "Watched" : "Read") : (k === "tv" ? "Mark watched" : "Mark read")}</button><button class="chip" id="u-thru">Mark all up to here</button></div>
        ${s.done ? `<label class="field"><span>Date</span><input type="date" id="u-date" value="${s.when || today()}"></label><div class="field"><span>Rating</span>${starPick("u-stars", s.ref.rating)}</div>` : ""}
      </div>` : ""}`;
  }
  sheet(`
    <div class="sheet-head"><span class="kind c-${k}">${LABEL[k]}</span><button class="x" data-close>Close</button></div>
    <div class="detail-top">${cover(k, nameOf(k, x), k === "book" ? x.authors[0] : "", { img: artOf(k, x) })}
      <div><h2>${esc(nameOf(k, x))}</h2><p>${esc(subOf(k, x))}</p>
      ${k === "book" && x.rating != null ? `<p>${stars(x.rating)}</p>` : ""}${k === "tv" && showRating(x) != null ? `<p>Show average ${stars(showRating(x))}</p>` : ""}</div>
    </div>
    <div class="field"><span>Status</span><div class="controls">${STATUS[k].map(([s, l]) => `<button class="chip small" data-set="${s}" aria-pressed="${x.status === s}">${l}</button>`).join("")}</div></div>
    ${mid}
    ${k !== "book" && (x.tmdb || x.cv) ? `<button class="chip" id="refresh" style="justify-self:start">Check for new ${k === "tv" ? "episodes" : "issues"}</button>` : ""}
    <div class="field"><span>Status history</span>${x.history.length ? `<ul class="timeline">${[...x.history].reverse().map(h => `<li><span class="num">${longDate(h.d)}</span><span>${VERB[k][h.s]}</span><span></span></li>`).join("")}</ul>` : `<p class="hint">Status changes are dated from here on.</p>`}</div>
    ${x.review ? `<div class="field"><span>Notes</span><p style="margin:0">${esc(x.review)}</p></div>` : ""}
  `, el => {
    const re = () => openDetail(k, id);
    $$("[data-set]", el).forEach(b => b.onclick = () => { if (x.status === b.dataset.set) return; k === "book" ? setBookStatus(x, b.dataset.set) : setStatus(k, x, b.dataset.set); toast(`Moved to ${STATUS[k].find(s => s[0] === b.dataset.set)[1]}`); re(); });
    const rf = $("#refresh", el);
    if (rf) rf.onclick = async () => {
      rf.disabled = true; rf.textContent = "Checking…";
      try {
        const { doc } = await post("/api/refresh", { kind: KIND_OF[k], id });
        const arr = items(k), i = arr.findIndex(z => z.id === id); arr[i] = doc; snap.set(keyOf(KIND_OF[k], id), JSON.stringify(doc)); saveLocal();
        const p = progress(k, doc); toast(p.next ? `Up to date. Next: ${p.next.label}` : "Up to date"); openDetail(k, id);
      } catch (e) { toast(e.message); rf.disabled = false; rf.textContent = "Try again"; }
    };
    if (k === "book") return bindBook(x, el, re);
    $$("[data-u]", el).forEach(b => b.onclick = () => { sel = sel === b.dataset.u ? null : b.dataset.u; re(); });
    const us = units(k, x), idx = us.findIndex(u => u.key === sel); if (idx < 0) return;
    const s = us[idx], field = k === "tv" ? "watched" : "read";
    const mark = (u, on) => { u.ref[field] = on ? (u.ref[field] || today()) : null; };
    $("#u-done", el).onclick = () => { mark(s, !s.done); autoStatus(k, x); re(); };
    $("#u-thru", el).onclick = () => { us.forEach((u, n) => { if (u.out && n <= idx) mark(u, true); }); autoStatus(k, x); toast(`Marked through ${s.label}`); re(); };
    const di = $("#u-date", el); if (di) di.onchange = e => { s.ref[field] = e.target.value || today(); re(); };
    if ($("#u-stars", el)) bindStars("u-stars", () => s.ref.rating, v => s.ref.rating = v, re);
  });
}

/* book body: format, totals, progress by page / chapter / audiobook time, reading days, reads and rereads */
function bookBody(b) {
  const r = curRead(b), last = r?.sessions.at(-1), u = bookUnit || last?.unit || unitOf(b), pct = bookPct(b);
  const days = bookDays(b).slice().reverse();
  return `
    <div class="field"><span>Format</span><div class="controls">${FORMATS.map(([f, l]) => `<button class="chip small" data-fmt="${f}" aria-pressed="${b.format === f}">${l}</button>`).join("")}</div></div>
    ${r ? `<div class="editor c-book">
      <b>${last ? `${atLabel(b, last)}${pct != null ? `, ${pct}%` : ""}` : "No progress logged yet"}</b>
      ${pct != null ? `<div class="bar-progress"><i style="width:${pct}%"></i></div>` : ""}
      <div class="controls">${[["page","Page"],["chapter","Chapter"],["time","Audiobook time"]].map(([v, l]) => `<button class="chip small" data-unit="${v}" aria-pressed="${u === v}">${l}</button>`).join("")}</div>
      <div class="inline">
        ${u === "time" ? `<span class="lbl">Listened to</span><input id="p-h" type="number" min="0" inputmode="numeric" placeholder="0"><span>h</span><input id="p-m" type="number" min="0" max="59" inputmode="numeric" placeholder="0"><span>m</span></div>
      <div class="inline"><span class="lbl">Total length</span><input id="p-th" type="number" min="0" placeholder="0" value="${b.minutes ? Math.floor(b.minutes / 60) : ""}"><span>h</span><input id="p-tm" type="number" min="0" max="59" placeholder="0" value="${b.minutes ? b.minutes % 60 : ""}"><span>m</span>`
          : `<span class="lbl">${cap(u)}</span><input id="p-at" type="number" min="0" inputmode="numeric"><span>of</span><input id="p-total" type="number" min="1" inputmode="numeric" value="${totalFor(b, u) ?? ""}" placeholder="total">`}
      </div>
      <div class="inline"><input type="date" id="p-date" value="${today()}" style="width:auto"><button class="save" id="p-save" style="padding:8px 16px">Save progress</button></div>
      <p class="hint">Totals fill in from Open Library when known. You can always type your own edition's.</p>
    </div>` : ""}
    ${days.length ? `<div class="field"><span>Reading days</span><ul class="timeline">${days.map(d => `<li><span class="num">${longDate(d.d)}</span><span>${d.unit === "time" ? `+${hm(d.amt) || "0m"} listened` : `+${d.amt} ${d.unit}${d.amt === 1 ? "" : "s"}`}</span><span class="hint">${d.unit === "time" ? hm(d.at) : `${cap(d.unit)} ${d.at}`}</span></li>`).join("")}</ul></div>` : ""}
    ${b.reads.length ? `<div class="field"><span>Reads</span><ul class="timeline">${b.reads.map((rd, n) => `<li><span class="num">Read ${n + 1}</span><span>${shortDate(rd.start)}${rd.end ? ` to ${longDate(rd.end)}` : ", in progress"}${rd.outcome === "dnf" ? ", DNF" : ""}</span><span>${rd.outcome === "read" ? stars(rd.rating) : ""}</span></li>`).join("")}</ul></div>` : ""}
    ${!r && b.reads.some(rd => rd.outcome === "read") ? `<button class="chip" id="reread" style="justify-self:start">Start a reread</button>` : ""}`;
}
function bindBook(b, el, re) {
  $$("[data-fmt]", el).forEach(x => x.onclick = () => { b.format = x.dataset.fmt; bookUnit = null; re(); });
  $$("[data-unit]", el).forEach(x => x.onclick = () => { bookUnit = x.dataset.unit; re(); });
  const rr = $("#reread", el); if (rr) rr.onclick = () => { setBookStatus(b, "reading", today(), { reread: true }); toast("Reread started"); re(); };
  const sv = $("#p-save", el); if (!sv) return;
  sv.onclick = () => {
    const u = bookUnit || curRead(b).sessions.at(-1)?.unit || unitOf(b), d = $("#p-date", el).value || today();
    let at;
    if (u === "time") { at = (+$("#p-h", el).value || 0) * 60 + (+$("#p-m", el).value || 0); const t = (+$("#p-th", el).value || 0) * 60 + (+$("#p-tm", el).value || 0); if (t) b.minutes = t; }
    else { at = +$("#p-at", el).value; const t = +$("#p-total", el).value; if (t) b[u === "page" ? "pages" : "chapters"] = t; }
    if (!at) return toast(u === "time" ? "Enter where you are in the audiobook" : `Enter your ${u}`);
    const rd = curRead(b); rd.sessions.push({ d, unit: u, at }); rd.sessions.sort((a, z) => a.d.localeCompare(z.d));
    const t = totalFor(b, u); if (t && at >= t) { setBookStatus(b, "read", d); toast("Marked finished. Rate it from the + button."); } else toast("Progress saved");
    re();
  };
}
document.addEventListener("click", e => { const o = e.target.closest("[data-open]"); if (o) { const [k, id] = o.dataset.open.split(/:(.*)/); sel = null; bookUnit = null; openDetail(k, id); } });

/* ================= TOP 10 ================= */
function renderTop() {
  const k = state.topCat, list = topList(k, state.topScope);
  $("#app").innerHTML = `
  <div class="view">
    <div class="page-head">
      <h1>Top 10</h1>
      <div class="status-row">${["film","tv","book","comic"].map(c => `<button class="chip" data-tc="${c}" aria-pressed="${k === c}">${PLURAL[c]}<span class="n">${topList(c, state.topScope).length}/10</span></button>`).join("")}</div>
      <div class="views" role="group">${[["all","All time"],["year",YEAR]].map(([s, l]) => `<button data-ts="${s}" aria-pressed="${state.topScope === s}">${l}</button>`).join("")}</div>
    </div>
    <ol class="tops c-${k}">
      ${Array.from({ length: 10 }, (_, n) => { const id = list[n];
        if (!id) return `<li class="slot"><span class="rank">${n + 1}</span>${n === list.length && items(k).length ? `<button class="add" data-add>Add your #${n + 1}</button>` : ""}</li>`;
        const x = find(k, id); return `<li class="filled"><span class="rank">${n + 1}</span>${cover(k, nameOf(k, x), "", { thumb: true, img: artOf(k, x) })}<span class="t"><b>${esc(nameOf(k, x))}</b><span>${esc(k === "book" ? x.authors[0] : k === "comic" ? x.publisher : x.year)}</span></span>
        <span class="acts"><button data-up="${n}" aria-label="Move up" ${n ? "" : "disabled"}>↑</button><button data-down="${n}" aria-label="Move down" ${n < list.length - 1 ? "" : "disabled"}>↓</button><button data-rm="${n}" aria-label="Remove">×</button></span></li>`; }).join("")}
    </ol>
    ${items(k).length ? "" : `<p class="note">Picks come from what you've logged, so this opens up once you start tracking ${PLURAL[k] === "TV" ? "shows" : PLURAL[k].toLowerCase()}.</p>`}
  </div>`;
  $$("[data-tc]").forEach(b => b.onclick = () => { state.topCat = b.dataset.tc; renderTop(); });
  $$("[data-ts]").forEach(b => b.onclick = () => { state.topScope = b.dataset.ts; renderTop(); });
  $$("[data-up]").forEach(b => b.onclick = () => { const n = +b.dataset.up; [list[n - 1], list[n]] = [list[n], list[n - 1]]; renderTop(); });
  $$("[data-down]").forEach(b => b.onclick = () => { const n = +b.dataset.down; [list[n + 1], list[n]] = [list[n], list[n + 1]]; renderTop(); });
  $$("[data-rm]").forEach(b => b.onclick = () => { list.splice(+b.dataset.rm, 1); renderTop(); });
  $$("[data-add]").forEach(b => b.onclick = () => pickTop(k, list));
}
function pickTop(k, list, q = "") {
  let xs = items(k).filter(x => !list.includes(x.id));
  if (state.topScope === "year" && k === "film") xs = xs.filter(x => D.watches.some(w => w.film === x.id && w.date.startsWith(YEAR)));
  if (k === "film") xs = xs.slice().sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  xs = xs.filter(x => nameOf(k, x).toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  sheet(`
    <div class="sheet-head"><h2>Add your #${list.length + 1}</h2><button class="x" data-close>Close</button></div>
    <input class="search" id="tp-q" type="search" placeholder="Search your ${PLURAL[k] === "TV" ? "shows" : PLURAL[k].toLowerCase()}" value="${esc(q)}">
    <div class="results">${xs.map(x => `<button data-pick="${esc(x.id)}"><b>${esc(nameOf(k, x))}</b><span>${k === "film" ? `${x.year} ${x.rating != null ? starText(x.rating) : ""}` : esc(subOf(k, x))}</span></button>`).join("") || `<p class="hint">No matches.</p>`}</div>
  `, el => {
    const i = $("#tp-q", el); i.oninput = e => { const p = e.target.selectionStart; pickTop(k, list, e.target.value); const n = $("#tp-q"); n.focus(); n.setSelectionRange(p, p); };
    $$("[data-pick]", el).forEach(b => b.onclick = () => { list.push(b.dataset.pick); closeSheet(); });
  });
}

/* ================= STATS ================= */
function barChart(labels, series, opts = {}) {
  const W = 400, H = 190, pad = { l: 26, r: 4, t: 18, b: 24 };
  const totals = labels.map((_, i) => series.reduce((n, s) => n + s.values[i], 0));
  const max = Math.max(...totals, 1), step = niceStep(max), top = Math.ceil(max / step) * step;
  const bw = (W - pad.l - pad.r) / labels.length, y = v => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  let g = "";
  for (let v = 0; v <= top; v += step) g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  labels.forEach((l, i) => {
    let acc = 0; const x = pad.l + i * bw + bw * 0.16, w = bw * 0.68;
    series.forEach(s => { const v = s.values[i]; if (!v) return; g += `<rect x="${x}" y="${y(acc + v)}" width="${w}" height="${y(acc) - y(acc + v)}" fill="${s.color}" rx="1.5"><title>${l}: ${v} ${s.key}</title></rect>`; acc += v; });
    if (totals[i] && opts.labelTotals) g += `<text class="v" x="${x + w / 2}" y="${y(totals[i]) - 5}" text-anchor="middle">${totals[i]}</text>`;
    if (!opts.sparse || i % opts.sparse === 0 || i === labels.length - 1) g += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${l}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}
function niceStep(max) { const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p; return Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p); }
const hbars = (rows, color, wide) => { if (!rows.length) return `<p class="note">Nothing yet.</p>`; const m = Math.max(...rows.map(r => r[1]), 1); return `<div class="hbars${wide ? " wide" : ""}">${rows.map(([l, v]) => `<div class="hbar"><span>${esc(l)}</span><span class="track"><span class="fill" style="width:${(v / m) * 100}%;background:${color}"></span></span><span class="n num">${v}</span></div>`).join("")}</div>`; };
const halfBuckets = rs => { const b = Array(10).fill(0); rs.forEach(r => { if (r) b[Math.round(r * 2) - 1]++; }); return b; };
const halfLabels = ["½","1","1½","2","2½","3","3½","4","4½","5"];
const fig = (v, l, pending) => `<div class="fig${pending ? " pending" : ""}"><b class="num">${v}</b><span>${l}</span></div>`;
const count = (arr, f) => Object.entries(arr.reduce((o, x) => { const key = f(x); if (key != null) o[key] = (o[key] || 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]);

function renderStats() {
  const now = new Date(), weeks = (now - new Date(+YEAR, 0, 1)) / 6048e5;
  const months = MONTHS.slice(0, now.getMonth() + 1).map(m => m.slice(0, 3));
  const perMonth = (arr, f = () => true) => months.map((_, i) => arr.filter(x => day(x.d).getMonth() === i && f(x)).length);
  const W = D.watches.filter(w => w.date.startsWith(YEAR)).map(w => ({ ...w, d: w.date }));
  const rated = W.filter(w => w.rating != null).map(w => w.rating);
  const decades = count(W, w => `${Math.floor(films[w.film].year / 10) * 10}s`).sort((a, b) => a[0].localeCompare(b[0]));
  const dow = Array(7).fill(0); W.forEach(w => dow[day(w.d).getDay()]++);
  const fives = [...new Map(W.filter(w => w.rating === 5).map(w => [w.film, films[w.film]])).values()];
  const busiest = Object.entries(W.reduce((o, w) => (o[w.d] = (o[w.d] || 0) + 1, o), {})).sort((a, b) => b[1] - a[1])[0];
  const thAvg = avg(W.filter(w => w.venue === "theater" && w.rating != null).map(w => w.rating)), homeAvg = avg(W.filter(w => w.venue !== "theater" && w.rating != null).map(w => w.rating));
  const filmMin = W.reduce((n, w) => n + (films[w.film].runtime || 0), 0);

  const eps = D.shows.flatMap(x => units("tv", x).filter(u => u.when?.startsWith(YEAR)).map(u => ({ ...u, x, d: u.when })));
  const epMin = eps.reduce((n, e) => n + (e.ref.runtime || 0), 0);
  const epRated = eps.filter(e => e.ref.rating != null).map(e => e.ref.rating);

  const days = D.books.flatMap(b => bookDays(b).map(d => ({ ...d, b }))).filter(d => d.d.startsWith(YEAR));
  const pages = days.filter(d => d.unit === "page").reduce((n, d) => n + d.amt, 0), listened = days.filter(d => d.unit === "time").reduce((n, d) => n + d.amt, 0);
  const finished = D.books.flatMap(b => b.reads.filter(r => r.outcome === "read" && r.end?.startsWith(YEAR)).map(r => ({ b, r })));
  const last30 = Array.from({ length: 30 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 29 + i); return iso(d); });
  const iss = D.series.flatMap(x => units("comic", x).filter(u => u.when?.startsWith(YEAR)).map(u => ({ ...u, x, d: u.when })));

  $("#app").innerHTML = `
  <div class="view">
    <div class="page-head"><h1>Stats</h1><p class="note">Everything here covers ${YEAR} so far.</p></div>

    <section class="stat-sec">
      <h2>Films and TV <small>combined</small></h2>
      <div class="figs">${fig(W.length + eps.length, "films and episodes")}${fig(filmMin + epMin ? Math.round((filmMin + epMin) / 60).toLocaleString() : "—", "hours of screen time", !(filmMin + epMin))}${fig(avg([...rated, ...epRated]).toFixed(2), "average rating")}</div>
      <div class="charts">
        <div class="chart"><h3>Films and episodes per month</h3>
          ${barChart(months, [{ key: "films", color: "var(--film)", values: perMonth(W) }, { key: "episodes", color: "var(--tv)", values: perMonth(eps) }], { labelTotals: true })}
          <div class="legend"><span class="key"><i style="background:var(--film)"></i>Films</span><span class="key"><i style="background:var(--tv)"></i>TV episodes</span></div>
        </div>
      </div>
      ${filmMin ? "" : `<p class="note">Screen time fills in once runtimes come from TMDB.</p>`}
    </section>

    <section class="stat-sec">
      <h2>Films</h2>
      <div class="figs">${fig(W.length, "films logged")}${fig((W.length / weeks).toFixed(1), "per week")}${fig(W.filter(w => w.venue === "theater").length, "theater trips")}${fig(W.filter(w => w.rewatch).length, "rewatches")}${fig(avg(rated).toFixed(2), "average rating")}${fig(fives.length, "five-star films")}</div>
      <div class="charts">
        <div class="chart"><h3>Films per month</h3>${barChart(months, [{ key: "in theaters", color: "var(--film)", values: perMonth(W, w => w.venue === "theater") }, { key: "at home", color: "var(--ink-3)", values: perMonth(W, w => w.venue !== "theater") }], { labelTotals: true })}
          <div class="legend"><span class="key"><i style="background:var(--film)"></i>Theater</span><span class="key"><i style="background:var(--ink-3)"></i>Home and TV</span></div></div>
        <div class="chart"><h3>How you rate films</h3>${barChart(halfLabels, [{ key: "films", color: "var(--film)", values: halfBuckets(rated) }])}<p class="note">Theater visits average ${thAvg.toFixed(2)} stars, home viewings ${homeAvg.toFixed(2)}.</p></div>
        <div class="chart"><h3>Release decade</h3>${hbars(decades, "var(--film)")}</div>
        <div class="chart"><h3>Day of the week</h3>${hbars([1,2,3,4,5,6,0].map(i => [DOW[i], dow[i]]), "var(--ink-2)")}${busiest ? `<p class="note">Busiest day: ${shortDate(busiest[0])}, with ${busiest[1]} films.</p>` : ""}</div>
      </div>
      <div class="chart"><h3>Five stars this year</h3><ul class="five">${fives.map(f => `<li>${esc(f.title)} <span style="color:var(--ink-3)">${f.year}</span></li>`).join("")}</ul></div>
      <p class="note">Genres, directors, actors and hours watched fill in once each film is matched to TMDB.</p>
    </section>

    <section class="stat-sec">
      <h2>TV</h2>
      <div class="figs">${fig(eps.length, "episodes seen")}${fig(epMin.toLocaleString(), "minutes watched")}${fig(new Set(eps.map(e => e.x.id)).size, "shows watched")}${fig(D.shows.filter(x => x.history.some(h => h.s === "finished" && h.d.startsWith(YEAR))).length, "shows finished")}${fig(epRated.length ? avg(epRated).toFixed(2) : "—", "average episode rating", !epRated.length)}</div>
      <div class="charts">
        <div class="chart"><h3>Episodes per month</h3>${barChart(months, [{ key: "episodes", color: "var(--tv)", values: perMonth(eps) }], { labelTotals: true })}</div>
        <div class="chart"><h3>Most-watched shows</h3>${hbars(count(eps, e => e.x.title).slice(0, 6), "var(--tv)", true)}</div>
        <div class="chart"><h3>How you rate episodes</h3>${barChart(halfLabels, [{ key: "episodes", color: "var(--tv)", values: halfBuckets(epRated) }])}</div>
      </div>
    </section>

    <section class="stat-sec">
      <h2>Books</h2>
      <div class="figs">${fig(finished.length, "books finished")}${fig(pages.toLocaleString(), "pages read")}${fig(hm(listened) || "0h", "listened")}${fig(D.books.filter(b => b.status === "reading").length, "reading now")}${fig(finished.filter(f => f.b.reads.indexOf(f.r) > 0).length, "rereads")}${fig(avg(finished.map(f => f.r.rating).filter(r => r != null)).toFixed(2), "average rating")}</div>
      <div class="charts">
        <div class="chart"><h3>Reading, last 30 days</h3>${barChart(last30.map(d => String(day(d).getDate())), [{ key: "pages", color: "var(--book)", values: last30.map(d => days.filter(x => x.d === d && x.unit === "page").reduce((n, x) => n + x.amt, 0)) }, { key: "minutes listened", color: "var(--ink-3)", values: last30.map(d => days.filter(x => x.d === d && x.unit === "time").reduce((n, x) => n + x.amt, 0)) }], { sparse: 5 })}
          <div class="legend"><span class="key"><i style="background:var(--book)"></i>Pages</span><span class="key"><i style="background:var(--ink-3)"></i>Audiobook minutes</span></div></div>
        <div class="chart"><h3>Authors</h3>${hbars(count(D.books, b => b.authors[0]), "var(--book)", true)}</div>
        <div class="chart"><h3>Formats</h3>${hbars(count(D.books, b => FORMATS.find(f => f[0] === b.format)?.[1] ?? b.format), "var(--book)")}</div>
      </div>
    </section>

    <section class="stat-sec">
      <h2>Comics</h2>
      <div class="figs">${fig(iss.length, "issues read")}${fig(D.series.filter(x => x.status === "reading").length, "runs in progress")}${fig(D.series.filter(x => x.status === "caught").length, "caught up")}${fig(upcoming().length, "issues coming up")}</div>
      <div class="charts">
        <div class="chart"><h3>Issues per month</h3>${barChart(months, [{ key: "issues", color: "var(--comic)", values: perMonth(iss) }], { labelTotals: true })}</div>
        <div class="chart"><h3>By publisher</h3>${hbars(count(iss, i => i.x.publisher), "var(--comic)")}</div>
      </div>
    </section>
  </div>`;
}

/* ================= SHEETS ================= */
function sheet(html, bind) {
  const s = $("#scrim");
  s.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`; s.hidden = false;
  s.onclick = e => { if (e.target === s) closeSheet(); };
  $$("[data-close]", s).forEach(b => b.onclick = closeSheet);
  bind?.(s);
}
function closeSheet() { $("#scrim").hidden = true; $("#scrim").innerHTML = ""; log = null; route(); }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200); }
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#scrim").hidden) closeSheet(); });

/* ================= LOG SHEET ================= */
const BOOK_ACTS = [["progress","Progress"],["reading","Started"],["paused","Paused"],["read","Finished"],["dnf","DNF"],["want","Want to read"]];
function openLog(o = {}) {
  const e = o.edit;
  log = e ? { kind: "film", edit: e, pick: e.film, q: films[e.film].title, rating: e.rating, venue: e.venue, rewatch: e.rewatch, liked: films[e.film].liked, date: e.date, note: e.review || "", mode: "watched" }
    : { kind: o.kind || "film", pick: o.pick || null, q: o.title || "", rating: null, venue: "home", rewatch: !!(o.pick && D.watches.some(w => w.film === o.pick)), liked: !!films[o.pick]?.liked, date: today(), note: "", mode: "watched", act: "progress" };
  renderLog(); if (!log.pick) $("#log-q")?.focus();
}
function logResults() {
  const q = log.q.trim().toLowerCase(), k = log.kind; if (!q) return [];
  if (k === "film") return D.films.filter(f => f.title.toLowerCase().includes(q)).slice(0, 8).map(f => ({ id: f.id, a: f.title, b: f.year }));
  return items(k).filter(x => (nameOf(k, x) + " " + (x.authors || []).join(" ")).toLowerCase().includes(q)).slice(0, 8)
    .map(x => ({ id: x.id, a: nameOf(k, x), b: k === "book" ? x.authors[0] : progress(k, x).next ? `next ${progress(k, x).next.label}` : "caught up" }));
}
function renderLog() {
  const k = log.kind, res = logResults(), x = log.pick && k !== "film" ? find(k, log.pick) : null;
  const next = x && k !== "book" ? progress(k, x).next : null;
  const filmWatched = k === "film" && log.mode === "watched";
  const rateIt = filmWatched || (k === "book" && log.act === "read") || !!next;
  const canSave = log.pick && (k === "film" || k === "book" || next);
  sheet(`
    <div class="sheet-head"><h2>${log.edit ? "Edit entry" : "Log something"}</h2><button class="x" data-close>Close</button></div>
    ${log.edit ? "" : `<div class="seg" role="group" aria-label="What are you logging">${["film","tv","book","comic"].map(z => `<button data-k="${z}" aria-pressed="${k === z}">${LABEL[z]}</button>`).join("")}</div>`}
    ${k === "film" && !log.edit ? `<div class="seg two" role="group">${[["watched","Watched"],["want","Want to watch"]].map(([m, l]) => `<button data-mode="${m}" aria-pressed="${log.mode === m}">${l}</button>`).join("")}</div>` : ""}
    <input class="search" id="log-q" type="search" autocomplete="off" ${log.edit ? "disabled" : ""} placeholder="${{ film: "Film title", tv: "Show title", book: "Book title or author", comic: "Series name" }[k]}" value="${esc(log.q)}" aria-label="Search">
    ${log.q && !log.pick ? resultsHtml(res) : ""}
    ${log.pick ? `
      ${k === "book" ? `<div class="field"><span>What happened</span><div class="controls">${BOOK_ACTS.map(([a, l]) => `<button class="chip small" data-act="${a}" aria-pressed="${log.act === a}">${l}</button>`).join("")}</div></div>
        ${log.act === "progress" ? `<p class="hint">${curRead(x) ? "Opens the book, where you log a page, chapter or audiobook time for any day." : "Start the book first, then log progress."}</p>` : ""}` : ""}
      ${(k === "tv" || k === "comic") ? `<p style="margin:0;font-weight:700">${next ? `Marking ${esc(next.label)} as ${k === "tv" ? "watched" : "read"}` : "You're caught up on this one."}</p>` : ""}
      ${rateIt ? `<div class="field"><span>Rating</span>${starPick("log-stars", log.rating)}<p class="hint">Tap the left half of a star for a half star.</p></div>` : ""}
      ${filmWatched ? `<div class="controls"><button class="toggle" id="lg-like" aria-pressed="${log.liked}">♥ ${log.liked ? "Liked" : "Like"}</button><button class="toggle plain" id="lg-re" aria-pressed="${log.rewatch}">Rewatch</button></div>
        <div class="field"><span>Where</span><div class="controls">${Object.entries(VENUE).map(([v, l]) => `<button class="chip small" data-v="${v}" aria-pressed="${log.venue === v}">${l}</button>`).join("")}</div></div>` : ""}
      ${!(k === "book" && log.act === "progress") && !(k === "film" && log.mode === "want") ? `<label class="field"><span>Date</span><input type="date" id="log-date" value="${log.date}"></label>` : ""}
      ${filmWatched || (k === "book" && ["read", "dnf"].includes(log.act)) ? `<label class="field"><span>Notes</span><textarea id="log-note" rows="3" placeholder="Favorite moment, thoughts, anything">${esc(log.note)}</textarea></label>` : ""}
    ` : ""}
    <button class="save" id="log-save" ${canSave ? "" : "disabled"}>${log.edit ? "Save changes" : k === "film" && log.mode === "want" ? "Add to watchlist" : k === "book" && log.act === "progress" ? "Log progress" : "Save"}</button>
    ${log.edit ? `<button class="danger" id="log-del">Delete this entry</button>` : ""}
  `, s => {
    const keep = () => { const d = $("#log-date"), n = $("#log-note"); if (d) log.date = d.value; if (n) log.note = n.value; };
    const re = () => { keep(); renderLog(); };
    $$("[data-k]", s).forEach(b => b.onclick = () => { log.kind = b.dataset.k; log.pick = null; log.q = ""; log.remote = null; renderLog(); $("#log-q").focus(); });
    $$("[data-mode]", s).forEach(b => b.onclick = () => { log.mode = b.dataset.mode; re(); });
    $("#log-q").oninput = e => { log.q = e.target.value; log.pick = null; queueRemote(); const p = e.target.selectionStart; renderLog(); const i = $("#log-q"); i.focus(); i.setSelectionRange(p, p); };
    $$("[data-p]", s).forEach(b => b.onclick = () => { log.pick = b.dataset.p; log.q = b.querySelector("b").textContent; if (k === "film") { log.rewatch = D.watches.some(w => w.film === log.pick); log.liked = films[log.pick].liked; } renderLog(); });
    $$("[data-r]", s).forEach(b => b.onclick = () => pickRemote(b.dataset.r));
    $$("[data-v]", s).forEach(b => b.onclick = () => { log.venue = b.dataset.v; re(); });
    $$("[data-act]", s).forEach(b => b.onclick = () => { log.act = b.dataset.act; re(); });
    const on = (id, fn) => { const el = $(id, s); if (el) el.onclick = fn; };
    on("#lg-like", () => { log.liked = !log.liked; re(); });
    on("#lg-re", () => { log.rewatch = !log.rewatch; re(); });
    if ($("#log-stars", s)) bindStars("log-stars", () => log.rating, v => log.rating = v, re);
    on("#log-del", () => { D.watches = D.watches.filter(w => w !== log.edit); toast("Entry deleted"); closeSheet(); });
    on("#log-save", () => {
      keep();
      if (k === "film" && log.mode === "want") { const m = films[log.pick]; if (!D.watchlist.some(w => w.id === m.id)) D.watchlist.unshift({ id: m.id, title: m.title, year: m.year, added: today(), poster: m.poster, tmdb: m.tmdb ?? null }); toast("Added to watchlist"); return closeSheet(); }
      if (k === "film") {
        films[log.pick].liked = log.liked;
        const w = log.edit || { id: uid(), film: log.pick };
        Object.assign(w, { date: log.date, rating: log.rating, venue: log.venue, rewatch: log.rewatch, review: log.note || undefined });
        if (!log.edit) { D.watches.push(w); D.watchlist = D.watchlist.filter(z => z.id !== log.pick); }
        if (log.rating != null) films[log.pick].rating = log.rating;
        D.watches.sort((a, b) => b.date.localeCompare(a.date));
        toast(log.edit ? "Entry updated" : "Logged"); return closeSheet();
      }
      if (k === "book") {
        if (log.act === "progress") { const id = log.pick; if (!curRead(x)) return toast("Start the book first"); log = null; sel = null; bookUnit = null; return openDetail("book", id); }
        setBookStatus(x, log.act, log.date, { rating: log.rating }); if (log.note) x.review = log.note;
        toast("Logged"); return closeSheet();
      }
      if (next) { next.ref[k === "tv" ? "watched" : "read"] = log.date; next.ref.rating = log.rating; autoStatus(k, x); toast("Logged"); closeSheet(); }
    });
  });
}
$("#log-open").onclick = () => openLog(); $("#log-open-m").onclick = () => openLog();

/* ================= ROUTER ================= */
const VIEWS = { home: renderHome, films: renderFilms, tv: () => renderShelfPage("tv"), books: () => renderShelfPage("book"), comics: () => renderShelfPage("comic"), top10: renderTop, stats: renderStats, settings: renderSettings };
function route() {
  if (!D) return;
  const v = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "home";
  $$(".tabs a,.bottom a,.gear").forEach(a => a.getAttribute("href") === "#" + v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  VIEWS[v]();
}
window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(drawShelf, 150); });


/* ================= LIVE APP: sync, offline, sign-in, settings, search ================= */
const KIND_OF = { film: "film", tv: "show", book: "book", comic: "series" };      // UI kind -> stored kind
const SOURCE = { film: "TMDB", tv: "TMDB", book: "Open Library", comic: "Comic Vine" };

/* ---- tiny IndexedDB key-value store for the offline copy and unsent changes ---- */
const idb = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => { const r = indexedDB.open("stacks", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("kv", mode); const q = fn(t.objectStore("kv")); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
  return { get: k => tx("readonly", s => s.get(k)).catch(() => undefined), set: (k, v) => tx("readwrite", s => { s.put(v, k); }).catch(() => {}) };
})();

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts, headers: { "x-stacks": "1", ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) { signedOut(); throw Object.assign(new Error(body.error || "Sign in first."), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(body.error || `Request failed (${r.status})`), { status: r.status });
  return body;
}
const post = (path, data) => api(path, { method: "POST", body: JSON.stringify(data ?? {}) });

/* ---- library <-> documents ---- */
const COLL = { film: () => D.films, watch: () => D.watches, watchlist: () => D.watchlist, book: () => D.books, show: () => D.shows, series: () => D.series, top: () => Object.values(D.tops) };
function normTop(k, t) { t = t || {}; const out = { id: k, all: t.all || [], years: t.years || {} }; if (Array.isArray(t.year) && t.year.length) out.years[YEAR] = t.year; return out; }
function topList(k, scope) { const t = D.tops[k] ||= normTop(k); return scope === "all" ? t.all : (t.years[YEAR] ||= []); }
function buildD(docs) {
  D = { films: [], watches: [], watchlist: [], books: [], shows: [], series: [], tops: {} };
  for (const { kind, data } of docs) {
    if (kind === "top") D.tops[data.id] = normTop(data.id, data);
    else if (COLL[kind]) COLL[kind]().push(data);
  }
  ["film", "tv", "book", "comic"].forEach(k => D.tops[k] ||= normTop(k));
  D.watches.sort((a, b) => b.date.localeCompare(a.date));
  films = Object.fromEntries(D.films.map(f => [f.id, f]));
}
const allDocs = () => Object.entries(COLL).flatMap(([kind, get]) => get().map(data => ({ kind, id: data.id, data })));

/* ---- change tracking: after every tap, compare each document to its last saved copy ---- */
let snap = new Map(), outbox = new Map(), since = 0, online = navigator.onLine, flushing = false;
const keyOf = (kind, id) => `${kind}|${id}`;
function snapshot() { snap = new Map(allDocs().map(d => [keyOf(d.kind, d.id), JSON.stringify(d.data)])); }
function detect() {
  if (!D) return;
  const cur = new Map();
  for (const d of allDocs()) cur.set(keyOf(d.kind, d.id), [d, JSON.stringify(d.data)]);
  let changed = false;
  for (const [k, [d, s]] of cur) if (snap.get(k) !== s) { outbox.set(k, { kind: d.kind, id: d.id, data: d.data }); snap.set(k, s); changed = true; }
  for (const k of [...snap.keys()]) if (!cur.has(k)) { const [kind, id] = k.split(/\|(.*)/); outbox.set(k, { kind, id, data: null }); snap.delete(k); changed = true; }
  if (changed) { films = Object.fromEntries(D.films.map(f => [f.id, f])); saveLocal(); flush(); }
}
["click", "change"].forEach(ev => document.addEventListener(ev, () => setTimeout(detect, 30), true));

let saveTimer;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { idb.set("library", { since, docs: allDocs() }); idb.set("outbox", [...outbox.values()]); }, 300);
  syncPill();
}

async function flush() {
  if (flushing || !outbox.size || !navigator.onLine) return syncPill();
  flushing = true; syncPill();
  const batch = [...outbox.entries()].slice(0, 400);
  try {
    await post("/api/sync", { changes: batch.map(([, c]) => c) });
    batch.forEach(([k, c]) => { if (outbox.get(k) === c) outbox.delete(k); });
    saveLocal();
  } catch (e) { if (e.status !== 401) console.warn("sync", e); }
  flushing = false; syncPill();
  if (outbox.size && navigator.onLine) setTimeout(flush, 3000);
}

function applyRemote(items) {
  let touched = false;
  for (const it of items) {
    const k = keyOf(it.kind, it.id);
    if (outbox.has(k) || !COLL[it.kind]) continue;         // your unsent edit wins until it's saved
    if (it.kind === "top") { if (!it.deleted) D.tops[it.id] = normTop(it.id, it.data); }
    else {
      const arr = COLL[it.kind](), i = arr.findIndex(x => x.id === it.id);
      if (it.deleted) { if (i >= 0) arr.splice(i, 1); }
      else if (i >= 0) arr[i] = it.data; else arr.push(it.data);
    }
    it.deleted ? snap.delete(k) : snap.set(k, JSON.stringify(it.deleted ? null : (it.kind === "top" ? D.tops[it.id] : it.data)));
    touched = true;
  }
  if (touched) { D.watches.sort((a, b) => b.date.localeCompare(a.date)); films = Object.fromEntries(D.films.map(f => [f.id, f])); }
  return touched;
}

async function pull() {
  if (!navigator.onLine) return syncPill();
  try {
    const r = await api(`/api/library?since=${since}`);
    if (!D || since === 0) { buildD(r.items.filter(i => !i.deleted)); snapshot(); since = r.now; saveLocal(); return route(); }
    since = r.now;
    if (applyRemote(r.items)) { saveLocal(); if ($("#scrim").hidden) route(); }
    else saveLocal();
  } catch (e) { if (e.status !== 401) console.warn("pull", e); }
}

function syncPill() {
  const p = $("#sync"); if (!p) return;
  const n = outbox.size;
  if (!navigator.onLine) { p.hidden = false; p.className = "sync off"; p.textContent = n ? `Offline, ${n} to sync` : "Offline"; }
  else if (n) { p.hidden = false; p.className = "sync"; p.textContent = flushing ? "Saving…" : `${n} to sync`; }
  else p.hidden = true;
}
window.addEventListener("online", () => { flush(); pull(); });
window.addEventListener("offline", syncPill);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && D) { flush(); pull(); } });
setInterval(() => { if (document.visibilityState === "visible" && D) pull(); }, 60000);

/* ---- search beyond your library (TMDB, Open Library, Comic Vine) ---- */
let remoteTimer;
function queueRemote() {
  clearTimeout(remoteTimer);
  const q = log.q.trim(), kind = log.kind;
  if (q.length < 2) { log.remote = null; return; }
  if (!navigator.onLine) { log.remote = { error: "You're offline, so only your library is searchable." }; return; }
  log.remote = { loading: true };
  remoteTimer = setTimeout(async () => {
    try { const r = await api(`/api/search?kind=${kind}&q=${encodeURIComponent(q)}`); if (log && log.q.trim() === q && log.kind === kind) { log.remote = { results: r.results }; keepFocus(renderLog); } }
    catch (e) { if (log && log.q.trim() === q) { log.remote = { error: e.message }; keepFocus(renderLog); } }
  }, 350);
}
function keepFocus(fn) {
  const a = document.activeElement, id = a?.id, s = a?.selectionStart;
  fn();
  const n = id && document.getElementById(id);
  if (n) { n.focus(); try { n.setSelectionRange(s, s); } catch {} }
}
function inLibrary(kind, r) {
  if (kind === "film") return D.films.some(f => String(f.tmdb) === r.ref);
  if (kind === "tv") return D.shows.some(s => String(s.tmdb) === r.ref);
  if (kind === "comic") return D.series.some(s => String(s.cv) === r.ref);
  return D.books.some(b => b.olKey === r.ref || (b.title.toLowerCase() === r.title.toLowerCase() && (b.authors[0] || "") === (r.authors?.[0] || "")));
}
function resultsHtml(res) {
  const rem = log.remote, kind = log.kind;
  const remote = rem?.results?.filter(r => !inLibrary(kind, r)) || [];
  return `<div class="results">
    ${res.length ? `<h4>In your library</h4>${res.map(r => `<button data-p="${esc(r.id)}"><b>${esc(r.a)}</b><span>${esc(r.b)}</span></button>`).join("")}` : ""}
    ${rem?.loading ? `<p class="hint">Searching ${SOURCE[kind]}…</p>` : ""}
    ${rem?.error ? `<p class="hint">${esc(rem.error)}</p>` : ""}
    ${remote.length ? `<h4>From ${SOURCE[kind]}</h4>${remote.map(r => `<button data-r="${esc(r.ref)}"><span class="rl">${r.poster || r.cover ? `<img src="${esc(r.poster || r.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}<b>${esc(r.title)}</b></span><span>${esc(r.sub ?? "")}</span></button>`).join("")}` : ""}
    ${!res.length && rem?.results && !remote.length ? `<p class="hint">No matches. Try a different spelling.</p>` : ""}
  </div>`;
}
async function pickRemote(ref) {
  const kind = log.kind, r = log.remote?.results?.find(x => x.ref === ref); if (!r) return;
  if (kind === "book") {
    const id = `${r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${ref.split("/").pop().toLowerCase()}`;
    if (!D.books.some(b => b.id === id)) D.books.push({ id, title: r.title, authors: r.authors.length ? r.authors : ["Unknown"], isbn: r.isbn, olKey: ref, format: "paperback", status: "want", history: [{ s: "want", d: today() }], reads: [], rating: null, review: null, cover: r.cover, pages: r.pages, chapters: null, minutes: null, coverTried: true });
    Object.assign(log, { pick: id, q: r.title, remote: null, act: "reading" });
    return renderLog();
  }
  toast(`Adding ${r.title}…`);
  try {
    const { doc } = await post("/api/add", { kind, ref });
    const sk = KIND_OF[kind], arr = COLL[sk]();
    if (!arr.some(x => x.id === doc.id)) arr.push(doc);
    snap.set(keyOf(sk, doc.id), JSON.stringify(doc));
    if (kind === "film") { films[doc.id] = doc; log.rewatch = D.watches.some(w => w.film === doc.id); log.liked = !!doc.liked; }
    Object.assign(log, { pick: doc.id, q: nameOf(kind, doc), remote: null });
    saveLocal(); renderLog();
  } catch (e) { toast(e.message); }
}

/* ---- sign-in, setup and adding a device ---- */
const deviceName = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android phone" : /Windows/.test(u) ? "Windows PC" : /Mac/.test(u) ? "Mac" : "Device"; };
function signedOut() { if (!document.body.classList.contains("locked")) renderAuth(true); }
function renderAuth(hasPasskey, msg = "") {
  document.body.classList.add("locked");
  const pair = new URLSearchParams(location.search).get("pair");
  const spines = `<div class="auth-spines" aria-hidden="true">${[["film", 38], ["tv", 52], ["book", 30], ["comic", 44]].map(([k, h]) => `<i style="height:${h}px;background:var(--${k})"></i>`).join("")}</div>`;
  let body;
  if (pair) body = `<h1>Add this device</h1><p>Create a passkey on this ${deviceName()} so it can open Stacks.</p>
      <label class="field"><span>Device name</span><input id="a-label" value="${deviceName()}"></label><button class="save" id="a-go">Create passkey</button>`;
  else if (!hasPasskey) body = `<h1>Set up Stacks</h1><p>Enter the setup code you chose, then create a passkey. This device becomes the owner.</p>
      <label class="field"><span>Setup code</span><input id="a-code" type="password" autocomplete="off"></label>
      <label class="field"><span>Device name</span><input id="a-label" value="${deviceName()}"></label><button class="save" id="a-go">Create passkey</button>`;
  else body = `<h1>Stacks</h1><p>Sign in with the passkey on this device.</p><button class="save" id="a-go">Sign in with passkey</button>
      <p class="hint">New device? On a device that's already signed in, open Settings and choose Add a device.</p>`;
  $("#app").innerHTML = `<div class="auth"><div class="auth-card">${spines}${body}${msg ? `<p class="err">${esc(msg)}</p>` : ""}</div></div>`;
  const B = window.SimpleWebAuthnBrowser;
  $("#a-go").onclick = async () => {
    const btn = $("#a-go"); btn.disabled = true;
    try {
      if (pair || !hasPasskey) {
        const optionsJSON = await post("/api/auth/register/options", pair ? { pairCode: pair } : { setupCode: $("#a-code").value.trim() });
        const response = await B.startRegistration({ optionsJSON });
        await post("/api/auth/register/verify", { response, label: $("#a-label").value.trim() || deviceName() });
      } else {
        const optionsJSON = await post("/api/auth/login/options");
        const response = await B.startAuthentication({ optionsJSON });
        await post("/api/auth/login/verify", { response });
      }
      history.replaceState(null, "", "/" + (location.hash || "#home"));
      document.body.classList.remove("locked");
      start();
    } catch (e) {
      const m = e.name === "NotAllowedError" ? "The passkey prompt was closed. Try again." : e.message;
      renderAuth(hasPasskey, m);
    }
  };
}

/* ---- settings ---- */
function applyTheme() { let t = "system"; try { t = localStorage.getItem("theme") || "system"; } catch {} t === "system" ? document.documentElement.removeAttribute("data-theme") : document.documentElement.setAttribute("data-theme", t); return t; }
function renderSettings() {
  const theme = applyTheme();
  $("#app").innerHTML = `
  <div class="view settings">
    <div class="page-head"><h1>Settings</h1></div>
    <section><h2>Devices</h2><div id="devices"><p class="hint">Loading…</p></div>
      <div id="pair-box"></div>
      <button class="chip" id="pair-btn" style="justify-self:start">Add a device</button></section>
    <section><h2>Look</h2><div class="controls">${[["system","Match device"],["light","Light"],["dark","Dark"]].map(([v, l]) => `<button class="chip" data-theme-set="${v}" aria-pressed="${theme === v}">${l}</button>`).join("")}</div></section>
    <section><h2>Data</h2><div id="sources"><p class="hint">Loading…</p></div>
      <div class="row-line"><span>${D.watches.length} diary entries, ${D.books.length} books, ${D.shows.length} shows, ${D.series.length} comic series<small>${outbox.size ? `${outbox.size} changes waiting to sync` : "Everything is synced"}</small></span><a class="chip" href="/api/export" download>Export</a></div></section>
    <section><h2>Account</h2><button class="chip" id="signout" style="justify-self:start">Sign out of this device</button>
      <p class="hint">This product uses the TMDB API but is not endorsed or certified by TMDB. Book data from Open Library, comic data from Comic Vine and Metron.</p></section>
  </div>`;
  $$("[data-theme-set]").forEach(b => b.onclick = () => { try { localStorage.setItem("theme", b.dataset.themeSet); } catch {} renderSettings(); });
  $("#signout").onclick = async () => { await post("/api/auth/logout").catch(() => {}); location.reload(); };
  $("#pair-btn").onclick = async () => {
    try {
      const p = await post("/api/auth/pair"), qr = qrcode(0, "M"); qr.addData(p.url); qr.make();
      $("#pair-box").innerHTML = `<div class="pair"><b>Scan this with your other device</b><div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2 })}</div>
        <p class="hint">Or open this link on it. It works once, for ${p.expiresInMinutes} minutes.</p><code>${esc(p.url)}</code><button class="chip small" id="copy">Copy link</button></div>`;
      $("#copy").onclick = () => navigator.clipboard.writeText(p.url).then(() => toast("Link copied"), () => toast("Couldn't copy. Select the link instead."));
    } catch (e) { toast(e.message); }
  };
  api("/api/auth/devices").then(r => {
    $("#devices").innerHTML = r.devices.map(d => `<div class="row-line"><span>${esc(d.label)}${d.current ? " (this device)" : ""}<small>Added ${longDate(new Date(d.created_at).toISOString().slice(0, 10))}${d.last_used ? `, last sign-in ${longDate(new Date(d.last_used).toISOString().slice(0, 10))}` : ""}</small></span>${r.devices.length > 1 && !d.current ? `<button class="linkish" data-rm-dev="${esc(d.id)}">Remove</button>` : ""}</div>`).join("");
    $$("[data-rm-dev]").forEach(b => b.onclick = async () => {
      if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to remove"; return; }
      try { await api(`/api/auth/devices/${encodeURIComponent(b.dataset.rmDev)}`, { method: "DELETE" }); toast("Device removed"); renderSettings(); } catch (e) { toast(e.message); }
    });
  }).catch(() => { $("#devices").innerHTML = `<p class="hint">Devices load when you're online.</p>`; });
  api("/api/status").then(s => {
    const row = (l, ok, extra = "") => `<div class="row-line"><span>${l}<small>${extra}</small></span><span class="${ok ? "ok" : "missing"}">${ok ? "Connected" : "Not set up"}</span></div>`;
    $("#sources").innerHTML = row("TMDB (films and TV)", s.sources.tmdb, s.unmatched ? `${s.unmatched} films still being matched` : `All films matched${s.failed ? `, ${s.failed} couldn't be found` : ""}`)
      + row("Comic Vine (comics)", s.sources.comicvine) + row("Metron (upcoming comics)", s.sources.metron)
      + row("Weekly GitHub backup", s.sources.backup, s.lastBackup ? `Last backup ${longDate(new Date(s.lastBackup).toISOString().slice(0, 10))}` : "No backup yet")
      + (s.failed ? `<button class="chip small" id="rematch" style="margin-top:8px">Try matching those ${s.failed} again</button>` : "")
      + `<p class="hint">${s.lastDaily ? `New episodes and issues last checked ${longDate(new Date(s.lastDaily).toISOString().slice(0, 10))}.` : "New episodes and issues are checked once a day."}</p>`;
    const rm = $("#rematch"); if (rm) rm.onclick = async () => { await post("/api/rematch").catch(e => toast(e.message)); toast("They'll be retried over the next hour"); renderSettings(); };
  }).catch(() => { $("#sources").innerHTML = `<p class="hint">Connection status loads when you're online.</p>`; });
}

/* ---- start ---- */
async function start() {
  applyTheme();
  const cached = await idb.get("library");
  (await idb.get("outbox") || []).forEach(c => outbox.set(keyOf(c.kind, c.id), c));
  let auth = null;
  try { auth = await (await fetch("/api/auth/state", { credentials: "same-origin" })).json(); } catch {}
  if (auth && !auth.signedIn) return renderAuth(auth.hasPasskey);
  if (!auth && !cached) { $("#app").innerHTML = `<div class="empty"><b>You're offline</b><p>Stacks needs a connection the first time it opens on a device.</p></div>`; return; }
  document.body.classList.remove("locked");
  if (cached) {
    since = cached.since; buildD(cached.docs.map(d => ({ kind: d.kind, data: d.data })));
    snapshot();
    for (const [k, c] of outbox) { if (c.data) { applyLocalPending(c); } else { const arr = COLL[c.kind]?.(); const i = arr?.findIndex(x => x.id === c.id); if (i >= 0) arr.splice(i, 1); } snap.delete(k); }
    snapshot();
    route();
  } else $("#app").innerHTML = `<p class="note">Loading your library…</p>`;
  syncPill();
  if (auth) { await flush(); await pull(); }
}
function applyLocalPending(c) {
  if (c.kind === "top") { D.tops[c.id] = normTop(c.id, c.data); return; }
  const arr = COLL[c.kind]?.(); if (!arr) return;
  const i = arr.findIndex(x => x.id === c.id); i >= 0 ? arr[i] = c.data : arr.push(c.data);
  films = Object.fromEntries(D.films.map(f => [f.id, f]));
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
start();
