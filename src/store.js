import { json, error, now } from "./util.js";

export const KINDS = new Set(["film", "watch", "watchlist", "book", "show", "series", "top"]);

/* Full library (since=0) or only what changed since a timestamp, including deletions. */
export async function getLibrary(env, since) {
  const at = now();
  const rows = since > 0
    ? (await env.DB.prepare("SELECT kind, id, data, deleted, updated_at FROM items WHERE updated_at > ?").bind(since).all()).results
    : (await env.DB.prepare("SELECT kind, id, data, deleted, updated_at FROM items WHERE deleted = 0").all()).results;
  return { now: at, items: rows.map(r => ({ kind: r.kind, id: r.id, deleted: !!r.deleted, updated_at: r.updated_at, data: r.deleted ? null : JSON.parse(r.data) })) };
}

export function upsertStmt(env, kind, id, data, at = now()) {
  return env.DB.prepare(
    "INSERT INTO items (kind, id, data, updated_at, deleted) VALUES (?, ?, ?, ?, 0) " +
    "ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0"
  ).bind(kind, id, JSON.stringify(data), at);
}
export function deleteStmt(env, kind, id, at = now()) {
  return env.DB.prepare(
    "INSERT INTO items (kind, id, data, updated_at, deleted) VALUES (?, ?, 'null', ?, 1) " +
    "ON CONFLICT(kind, id) DO UPDATE SET data = 'null', updated_at = excluded.updated_at, deleted = 1"
  ).bind(kind, id, at);
}

export async function getItem(env, kind, id) {
  const r = await env.DB.prepare("SELECT data FROM items WHERE kind = ? AND id = ? AND deleted = 0").bind(kind, id).first();
  return r ? JSON.parse(r.data) : null;
}
export async function getItems(env, kind) {
  return (await env.DB.prepare("SELECT data FROM items WHERE kind = ? AND deleted = 0").bind(kind).all()).results.map(r => JSON.parse(r.data));
}
export const putItem = (env, kind, id, data) => upsertStmt(env, kind, id, data).run();

/* POST /api/sync  { changes: [{ kind, id, data }] }  data:null = delete */
export async function handleSync(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.changes)) return error(400, "Expected { changes: [...] }");
  if (body.changes.length > 500) return error(413, "Send at most 500 changes at a time.");
  const at = now(), stmts = [];
  for (const c of body.changes) {
    if (!KINDS.has(c.kind) || typeof c.id !== "string" || !c.id || c.id.length > 200) return error(400, `Bad change: ${c.kind}/${c.id}`);
    stmts.push(c.data == null ? deleteStmt(env, c.kind, c.id, at) : upsertStmt(env, c.kind, c.id, c.data, at));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, now: at, saved: stmts.length });
}
