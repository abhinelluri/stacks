"""Normalize Letterboxd + StoryGraph exports into Stacks' data.json.

Comics and TV start empty (fresh start). Usage:
  python3 build_data.py <attachments_dir> <out_json> <flags_txt>
"""
import csv, json, re, sys, datetime
from pathlib import Path

src, out, report = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
flags = []


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def num(x):
    try:
        return float(x) if x not in ("", None) else None
    except ValueError:
        return None


def rows(pattern):
    return list(csv.DictReader(open(next(src.glob(pattern)), encoding="utf-8")))


# ---------- Films (Letterboxd) ----------
films = {}
for r in rows("*ratings.csv"):
    fid = f"{slug(r['Name'])}-{r['Year']}"
    films[fid] = {"id": fid, "title": r["Name"], "year": int(r["Year"]), "rating": num(r["Rating"]),
                  "liked": False, "lb": r["Letterboxd URI"],
                  # filled from TMDB in phase 4
                  "tmdb": None, "poster": None, "runtime": None, "directors": [], "cast": [], "genres": []}

# likes/films.csv only exists in Letterboxd's full export; use it when present
# Letterboxd ships likes as likes/films.csv; attachments may arrive as "<prefix>-films.csv"
likes = [p for p in src.glob("*films.csv") if "watchlist" not in p.name]
if likes:
    for r in csv.DictReader(open(likes[0], encoding="utf-8")):
        fid = f"{slug(r['Name'])}-{r['Year']}"
        if fid in films:
            films[fid]["liked"] = True
else:
    flags.append("No Letterboxd likes file attached, so no films are marked liked yet")

reviews = {r["Letterboxd URI"]: r["Review"].strip() for r in rows("*reviews.csv")}
watches = []
for n, r in enumerate(rows("*diary.csv")):
    fid = f"{slug(r['Name'])}-{r['Year']}"
    if fid not in films:
        films[fid] = {"id": fid, "title": r["Name"], "year": int(r["Year"]), "rating": num(r["Rating"]), "liked": False,
                      "lb": None, "tmdb": None, "poster": None, "runtime": None, "directors": [], "cast": [], "genres": []}
    tags = [t.strip() for t in r["Tags"].split(",") if t.strip()]
    venue = "theater" if "theater" in tags else "tv" if "tv" in tags else "home"  # Discord watches count as home
    w = {"id": f"w{n}", "film": fid, "date": r["Watched Date"], "rating": num(r["Rating"]),
         "rewatch": r["Rewatch"] == "Yes", "venue": venue}
    if reviews.get(r["Letterboxd URI"]):
        w["review"] = reviews[r["Letterboxd URI"]]
    watches.append(w)
watches.sort(key=lambda w: w["date"], reverse=True)

watchlist = []
wl = list(src.glob("*watchlist*.csv"))
if wl:
    for r in csv.DictReader(open(wl[0], encoding="utf-8")):
        watchlist.append({"id": f"{slug(r['Name'])}-{r['Year']}", "title": r["Name"], "year": int(r["Year"]),
                          "added": r["Date"], "poster": None})
else:
    flags.append("No Letterboxd watchlist file attached, so the watchlist starts empty")

# ---------- Books (StoryGraph) ----------
sg = next(p for p in src.glob("*.csv") if "Read Status" in p.open(encoding="utf-8").readline())
books = []
for r in csv.DictReader(open(sg, encoding="utf-8")):
    added = r["Date Added"].replace("/", "-")
    start = end = None
    if r["Dates Read"]:
        a, _, b = r["Dates Read"].partition("-")
        start, end = a.replace("/", "-"), (b or a).replace("/", "-")
    status = {"read": "read", "currently-reading": "reading", "to-read": "want",
              "did-not-finish": "dnf", "paused": "paused"}.get(r["Read Status"], "want")
    rating = num(r["Star Rating"])
    reads, history = [], []
    if status == "want":
        history = [{"s": "want", "d": added}]
    elif status in ("reading", "paused"):
        reads = [{"start": start or added, "end": None, "outcome": None, "rating": None, "sessions": []}]
        history = [{"s": "reading", "d": start or added}] + ([{"s": "paused", "d": added}] if status == "paused" else [])
    else:
        reads = [{"start": start or added, "end": end or added, "outcome": status, "rating": rating, "sessions": []}]
        history = [{"s": "reading", "d": start or added}, {"s": status, "d": end or added}]
    fmt = {"digital": "ebook", "audio": "audiobook"}.get(r["Format"], r["Format"] or "paperback")
    books.append({"id": slug(r["Title"]), "title": r["Title"], "authors": [a.strip() for a in r["Authors"].split(",")],
                  "isbn": r["ISBN/UID"], "format": fmt, "status": status, "history": history, "reads": reads,
                  "rating": rating, "review": r["Review"] or None,
                  # filled from Open Library / Google Books in phase 4, or typed in
                  "cover": None, "pages": None, "chapters": None, "minutes": None})

data = {
    "generated": datetime.date.today().isoformat(),
    "films": sorted(films.values(), key=lambda f: f["title"]),
    "watches": watches,
    "watchlist": watchlist,
    "books": books,
    "shows": [],    # {id,title,year,status,history,poster,seasons:[{n,episodes:[{n,title,runtime,airdate,watched,rating}]}]}
    "series": [],   # {id,name,volume,publisher,start,end,ongoing,status,history,cover,issues:[{n,released,cover,read,rating}]}
    "tops": {k: {"all": [], "year": []} for k in ("film", "tv", "book", "comic")},
}
out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
report.write_text("\n".join(flags) + "\n")
print(f"films {len(films)}  watches {len(watches)}  reviews {sum('review' in w for w in watches)}  "
      f"theater {sum(w['venue'] == 'theater' for w in watches)}  books {len(books)}  watchlist {len(watchlist)}")
print("\n".join(flags))
