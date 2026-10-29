/* Load data/seed.json (your converted Letterboxd + StoryGraph exports) into the database.
   Safe to re-run: anything already in the database is left alone.
   Usage: npm run import          (live database)
          npm run import:local    (local test database) */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const target = process.argv.includes("--local") ? "--local" : "--remote";
const seedPath = new URL("../data/seed.json", import.meta.url);
if (!existsSync(seedPath)) { console.error("data/seed.json is missing. It comes in the zip, next to this repo's code."); process.exit(1); }
const seed = JSON.parse(readFileSync(seedPath, "utf8"));

const docs = [
  ...seed.films.map(d => ["film", d]),
  ...seed.watches.map(d => ["watch", d]),
  ...seed.watchlist.map(d => ["watchlist", d]),
  ...seed.books.map(d => ["book", d]),
  ...(seed.shows || []).map(d => ["show", d]),
  ...(seed.series || []).map(d => ["series", d]),
  ...Object.keys(seed.tops || {}).map(k => ["top", { id: k, all: seed.tops[k].all || [], years: {} }]),
];
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const at = Date.now();
const sql = docs.map(([kind, d]) => `INSERT OR IGNORE INTO items (kind, id, data, updated_at, deleted) VALUES (${q(kind)}, ${q(d.id)}, ${q(JSON.stringify(d))}, ${at}, 0);`).join("\n");
const out = new URL("../data/seed.sql", import.meta.url);
writeFileSync(out, sql);

console.log(`Importing ${docs.length} records (${seed.watches.length} diary entries, ${seed.films.length} films, ${seed.watchlist.length} watchlist, ${seed.books.length} books)…`);
const r = spawnSync("npx", ["wrangler", "d1", "execute", "stacks-db", target, "--file", "data/seed.sql", "--yes"], { stdio: "inherit", shell: process.platform === "win32" });
if (r.status !== 0) { console.error("Import failed. Fix the error above and run it again; it won't create duplicates."); process.exit(r.status || 1); }
console.log("Done. Posters, covers and film details fill in over the next few hours.");
