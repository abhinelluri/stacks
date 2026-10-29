# Stacks

A private tracker for films, TV, books and comics. One Cloudflare Worker serves the app, the API, cached cover art and the scheduled jobs. It runs on Cloudflare's free plan.

Full walkthrough: the **Stacks Setup Guide** doc. Short version:

```
npm install
npx wrangler d1 create stacks-db              # answer "No" if asked to add it to your config
npx wrangler kv namespace create COVERS        # same
# paste both IDs into wrangler.jsonc, and your GitHub username into GITHUB_REPO
npm run migrate
npx wrangler secret put SETUP_CODE
npx wrangler secret put TMDB_TOKEN
npx wrangler secret put COMICVINE_KEY
npx wrangler secret put METRON_USER
npx wrangler secret put METRON_PASS
npx wrangler secret put GITHUB_TOKEN
npm run deploy
npm run import
```

## Layout

| Path | What it is |
| --- | --- |
| `public/` | The app: `index.html`, `app.js`, `styles.css`, service worker, icons |
| `src/index.js` | Router: API, `/img/` cover cache, static files, scheduled jobs |
| `src/auth.js` | Passkey sign-in, setup code, add-a-device links, sessions |
| `src/store.js` | Library storage and sync (`/api/library`, `/api/sync`) |
| `src/providers.js` | TMDB, Open Library, Comic Vine, Metron |
| `src/jobs.js` | Matching imported titles, new episodes and issues, weekly backup |
| `migrations/` | Database tables |
| `scripts/import.mjs` | Loads `data/seed.json` (your Letterboxd + StoryGraph history) |
| `scripts/convert-exports/` | The converter that produced `data/seed.json` from your exports |

## Scheduled jobs

| Schedule (UTC) | Job |
| --- | --- |
| Every 5 minutes | Match a few imported films, watchlist films and books to TMDB / Open Library |
| Daily 13:30 | New episodes for shows you follow, new and upcoming issues for your comics, cleanup |
| Sundays 08:00 | Commit `backups/library.json` to your GitHub repo |

## Handy commands

| Command | Does |
| --- | --- |
| `npm run deploy` | Publish code changes |
| `npm run logs` | Watch live logs from the Worker |
| `npm run dev` | Run locally at http://localhost:8787 (put test secrets in `.dev.vars`) |
| `npx wrangler secret put NAME` | Change a key |

## Data and privacy

- Everything you log lives in your own Cloudflare D1 database. Nothing is public: every API call and image needs a signed-in passkey session.
- `data/seed.json` and `.dev.vars` are git-ignored, so your history and keys never land in the repo. The weekly backup writes only to your private repo.
- This product uses the TMDB API but is not endorsed or certified by TMDB.
