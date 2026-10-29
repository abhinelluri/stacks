import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { json, error, now, b64url, fromB64url, randomToken, sha256, safeEqual, cookies, setCookie, getMeta, setMeta } from "./util.js";

const SESSION_COOKIE = "stacks_session";
const CHALLENGE_COOKIE = "stacks_chal";
const YEAR = 365 * 24 * 3600;
const USER_ID = new TextEncoder().encode("stacks-owner");

const rp = request => { const u = new URL(request.url); return { rpID: u.hostname, origin: u.origin }; };
const hasPasskey = async env => !!(await env.DB.prepare("SELECT 1 FROM credentials LIMIT 1").first());

export async function getSession(request, env) {
  const raw = cookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  const row = await env.DB.prepare("SELECT token, credential FROM sessions WHERE token = ? AND expires_at > ?")
    .bind(await sha256(raw), now()).first();
  return row || null;
}

async function startSession(env, credentialId) {
  const raw = randomToken(32);
  await env.DB.prepare("INSERT INTO sessions (token, credential, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(raw), credentialId, now(), now() + YEAR * 1000).run();
  return setCookie(SESSION_COOKIE, raw, YEAR);
}

async function saveChallenge(env, challenge, purpose) {
  const id = randomToken(16);
  await env.DB.prepare("INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, challenge, purpose, now() + 5 * 60 * 1000).run();
  return setCookie(CHALLENGE_COOKIE, id, 300);
}
async function takeChallenge(request, env) {
  const id = cookies(request)[CHALLENGE_COOKIE];
  if (!id) return null;
  const row = await env.DB.prepare("SELECT challenge, purpose FROM challenges WHERE id = ? AND expires_at > ?").bind(id, now()).first();
  await env.DB.prepare("DELETE FROM challenges WHERE id = ?").bind(id).run();
  return row;
}

/* Setup-code guesses are limited: 10 wrong tries locks setup for an hour */
async function checkSetupCode(env, code) {
  const lock = await getMeta(env, "setup_lock", { fails: 0, until: 0 });
  if (lock.until > now()) return "Too many wrong codes. Try again in an hour.";
  if (!env.SETUP_CODE) return "SETUP_CODE isn't set. Add it with: npx wrangler secret put SETUP_CODE";
  if (safeEqual(code || "", env.SETUP_CODE)) { await setMeta(env, "setup_lock", { fails: 0, until: 0 }); return null; }
  const fails = lock.fails + 1;
  await setMeta(env, "setup_lock", { fails: fails >= 10 ? 0 : fails, until: fails >= 10 ? now() + 3600e3 : 0 });
  return "That setup code isn't right.";
}

export async function handleAuth(request, env, path) {
  const method = request.method;
  const body = method === "POST" ? await request.json().catch(() => ({})) : {};

  if (path === "/api/auth/state" && method === "GET") {
    const s = await getSession(request, env);
    return json({ signedIn: !!s, hasPasskey: await hasPasskey(env) });
  }

  if (path === "/api/auth/register/options" && method === "POST") {
    const { rpID } = rp(request);
    let purpose;
    if (!(await hasPasskey(env))) {
      const problem = await checkSetupCode(env, body.setupCode);
      if (problem) return error(403, problem);
      purpose = "setup";
    } else if (body.pairCode) {
      const row = await env.DB.prepare("SELECT code FROM pair_codes WHERE code = ? AND expires_at > ?").bind(body.pairCode, now()).first();
      if (!row) return error(403, "That link has expired. Make a new one from Settings on your other device.");
      purpose = `pair:${body.pairCode}`;
    } else if (await getSession(request, env)) {
      purpose = "add";
    } else {
      return error(403, "Stacks already has an owner. Sign in, or use an Add a device link.");
    }
    const existing = (await env.DB.prepare("SELECT id, transports FROM credentials").all()).results;
    const options = await generateRegistrationOptions({
      rpName: "Stacks", rpID, userID: USER_ID, userName: "Stacks", userDisplayName: "Stacks",
      attestationType: "none",
      excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    return json(options, 200, { "set-cookie": await saveChallenge(env, options.challenge, purpose) });
  }

  if (path === "/api/auth/register/verify" && method === "POST") {
    const ch = await takeChallenge(request, env);
    if (!ch) return error(400, "That took too long. Try again.");
    if (ch.purpose === "setup" && (await hasPasskey(env))) return error(403, "Stacks already has an owner.");
    const { rpID, origin } = rp(request);
    let v;
    try {
      v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
    } catch (e) { return error(400, `Passkey couldn't be verified: ${e.message}`); }
    if (!v.verified) return error(400, "Passkey couldn't be verified.");
    const c = v.registrationInfo.credential;
    await env.DB.prepare("INSERT INTO credentials (id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(c.id, b64url(c.publicKey), c.counter, JSON.stringify(c.transports || []), String(body.label || "Device").slice(0, 60), now()).run();
    if (ch.purpose.startsWith("pair:")) await env.DB.prepare("DELETE FROM pair_codes WHERE code = ?").bind(ch.purpose.slice(5)).run();
    return json({ ok: true }, 200, { "set-cookie": await startSession(env, c.id) });
  }

  if (path === "/api/auth/login/options" && method === "POST") {
    const options = await generateAuthenticationOptions({ rpID: rp(request).rpID, userVerification: "preferred" });
    return json(options, 200, { "set-cookie": await saveChallenge(env, options.challenge, "login") });
  }

  if (path === "/api/auth/login/verify" && method === "POST") {
    const ch = await takeChallenge(request, env);
    if (!ch || ch.purpose !== "login") return error(400, "That took too long. Try again.");
    const cred = await env.DB.prepare("SELECT * FROM credentials WHERE id = ?").bind(body.response?.id || "").first();
    if (!cred) return error(403, "This passkey isn't registered with Stacks.");
    const { rpID, origin } = rp(request);
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
        credential: { id: cred.id, publicKey: fromB64url(cred.public_key), counter: cred.counter, transports: cred.transports ? JSON.parse(cred.transports) : undefined },
      });
    } catch (e) { return error(400, `Sign-in failed: ${e.message}`); }
    if (!v.verified) return error(403, "Sign-in failed.");
    await env.DB.prepare("UPDATE credentials SET counter = ?, last_used = ? WHERE id = ?").bind(v.authenticationInfo.newCounter, now(), cred.id).run();
    return json({ ok: true }, 200, { "set-cookie": await startSession(env, cred.id) });
  }

  /* everything below needs a signed-in session */
  const session = await getSession(request, env);
  if (!session) return error(401, "Sign in first.");

  if (path === "/api/auth/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(session.token).run();
    return json({ ok: true }, 200, { "set-cookie": setCookie(SESSION_COOKIE, "", 0) });
  }
  if (path === "/api/auth/pair" && method === "POST") {
    const code = randomToken(9);
    await env.DB.prepare("INSERT INTO pair_codes (code, expires_at) VALUES (?, ?)").bind(code, now() + 10 * 60e3).run();
    return json({ code, url: `${new URL(request.url).origin}/?pair=${code}`, expiresInMinutes: 10 });
  }
  if (path === "/api/auth/devices" && method === "GET") {
    const rows = (await env.DB.prepare("SELECT id, label, created_at, last_used FROM credentials ORDER BY created_at").all()).results;
    return json({ devices: rows.map(r => ({ ...r, current: r.id === session.credential })) });
  }
  const m = path.match(/^\/api\/auth\/devices\/(.+)$/);
  if (m && method === "DELETE") {
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials").first()).n;
    if (count <= 1) return error(400, "You can't remove your only passkey.");
    const id = decodeURIComponent(m[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM credentials WHERE id = ?").bind(id),
      env.DB.prepare("DELETE FROM sessions WHERE credential = ?").bind(id),
    ]);
    return json({ ok: true });
  }
  return error(404, "Not found");
}
