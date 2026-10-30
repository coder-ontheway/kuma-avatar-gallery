// =====================================================================
// 本機端到端測試用的「Supabase 相容測試伺服器」（僅供測試，不會部署）
//
// - REST：把 supabase-js 會用到的 PostgREST 語法轉成 SQL，並以 anon / authenticated /
//   service_role 角色在本機 PostgreSQL 執行 → 正式 migration 的 RLS 政策實際生效。
// - Auth：簡化版登入（核發 HS256 JWT），只支援測試帳號。
// - Storage：檔案存在暫存資料夾；上傳／刪除前以使用者身分寫入 storage.objects，
//   因此 Storage RLS 政策同樣實際生效；公開網址只對 public bucket 有效。
// - Functions：直接載入正式的 supabase/functions/download/handler.ts 執行。
// =====================================================================
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { handle } from "../../supabase/functions/download/handler.ts";

const JWT_SECRET = "e2e-test-jwt-secret-not-for-production-0123456789";
const TOKEN_SECRET = "e2e-download-token-secret-not-for-production-0123456789";
const TABLES = new Set(["images", "categories", "site_settings", "admins", "image_download_stats"]);
const RPCS = new Set(["is_admin", "set_download_password", "download_password_status"]);

export function createMockSupabase({ database, storageDir, users, port }) {
  const pool = new pg.Pool({ database, user: process.env.PGUSER || "root", host: "/var/run/postgresql", max: 8 });
  const sessions = new Map(); // refresh token → user
  fs.mkdirSync(storageDir, { recursive: true });

  // ---------------- JWT ----------------
  const b64 = (b) => Buffer.from(b).toString("base64url");
  function signJwt(payload) {
    const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
  }
  function verifyJwt(token) {
    const [h, b, s] = (token || "").split(".");
    if (!s) return null;
    const expect = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(s.padEnd(expect.length).slice(0, expect.length)))) return null;
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    if (p.exp && p.exp * 1000 < Date.now()) return null;
    return p;
  }
  const ANON_KEY = signJwt({ role: "anon", iss: "e2e" });
  const SERVICE_KEY = signJwt({ role: "service_role", iss: "e2e" });

  function claimsFrom(req) {
    const auth = req.headers.authorization?.replace(/^Bearer /i, "");
    const c = verifyJwt(auth) ?? verifyJwt(req.headers.apikey);
    return c ?? { role: "anon" };
  }

  async function asRole(claims, fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const role = ["anon", "authenticated", "service_role"].includes(claims.role) ? claims.role : "anon";
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await client.query(`set local role ${role}`);
      const r = await fn(client);
      await client.query("commit");
      return r;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ---------------- HTTP helpers ----------------
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, prefer, accept-profile, content-profile, x-upsert, cache-control, x-supabase-api-version",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "content-range",
  };
  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, { ...CORS, ...(isBuf ? {} : { "Content-Type": "application/json" }), ...headers });
    res.end(isBuf ? body : body === undefined ? "" : JSON.stringify(body));
  }
  function pgError(res, e) {
    const status = e.code === "42501" ? 403 : e.code?.startsWith("23") || e.code === "22023" || e.code === "P0001" ? 400 : 500;
    send(res, status, { code: e.code, message: e.message, details: null, hint: null });
  }
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }
  const ident = (s) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error("bad identifier"), { code: "PGRST100" });
    return `"${s}"`;
  };

  // ---------------- REST (PostgREST subset) ----------------
  function parseQuery(url) {
    const params = [];
    const where = [];
    let select = "*";
    let order = [];
    for (const [k, v] of url.searchParams) {
      if (k === "select") select = v;
      else if (k === "order") order = v.split(",");
      else if (k === "limit" || k === "offset" || k === "columns" || k === "on_conflict") continue;
      else {
        const m = /^(eq|neq|in|is|gt|lt|gte|lte)\.(.*)$/s.exec(v);
        if (!m) continue;
        const [, op, val] = m;
        if (op === "in") {
          const list = val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
          params.push(list);
          where.push(`${ident(k)}::text = any($${params.length})`);
        } else if (op === "is") {
          where.push(`${ident(k)} is ${val === "null" ? "null" : val === "true" ? "true" : "false"}`);
        } else {
          params.push(val);
          const sym = { eq: "=", neq: "<>", gt: ">", lt: "<", gte: ">=", lte: "<=" }[op];
          where.push(`${ident(k)}::text ${sym} $${params.length}::text`);
        }
      }
    }
    const cols = select === "*" ? "*" : select.split(",").map((c) => ident(c.trim())).join(",");
    const orderSql = order
      .map((o) => {
        const [col, dir] = o.split(".");
        return `${ident(col)} ${dir === "desc" ? "desc" : "asc"}`;
      })
      .join(",");
    return { params, where: where.length ? `where ${where.join(" and ")}` : "", cols, orderSql };
  }

  async function rest(req, res, url, sub) {
    const claims = claimsFrom(req);
    const single = (req.headers.accept || "").includes("vnd.pgrst.object");
    const respond = (rows) => {
      if (single) {
        if (rows.length !== 1) return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
        return send(res, 200, rows[0]);
      }
      return send(res, 200, rows);
    };

    if (sub.startsWith("rpc/")) {
      const fn = sub.slice(4);
      if (!RPCS.has(fn) && fn !== "verify_download_password" && fn !== "download_state") return send(res, 404, { message: "not found" });
      const args = JSON.parse((await readBody(req)).toString() || "{}");
      const names = Object.keys(args);
      const sql = `select to_jsonb(public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(",")})) as r`;
      try {
        const r = await asRole(claims, (c) => c.query(sql, names.map((n) => args[n])));
        return send(res, 200, r.rows[0].r);
      } catch (e) {
        return pgError(res, e);
      }
    }

    const table = sub;
    if (!TABLES.has(table)) return send(res, 404, { message: "not found" });
    try {
      const q = parseQuery(url);
      const wantReturn = (req.headers.prefer || "").includes("return=representation");
      const returning = wantReturn ? `returning ${q.cols}` : "returning 1 as ok";
      let sql;
      let params = q.params;
      if (req.method === "GET") {
        sql = `select coalesce(json_agg(t), '[]') as r from (select ${q.cols} from public.${ident(table)} ${q.where} ${q.orderSql ? "order by " + q.orderSql : ""}) t`;
      } else if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString());
        const rows = Array.isArray(body) ? body : [body];
        const keys = Object.keys(rows[0]);
        params = [];
        const values = rows.map((row) => `(${keys.map((k) => (params.push(row[k]), `$${params.length}`)).join(",")})`);
        sql = `with r as (insert into public.${ident(table)} (${keys.map(ident).join(",")}) values ${values.join(",")} ${returning}) select coalesce(json_agg(r), '[]') as r from r`;
      } else if (req.method === "PATCH") {
        const body = JSON.parse((await readBody(req)).toString());
        const sets = Object.keys(body).map((k) => (params.push(body[k]), `${ident(k)} = $${params.length}`));
        sql = `with r as (update public.${ident(table)} set ${sets.join(",")} ${q.where} ${returning}) select coalesce(json_agg(r), '[]') as r from r`;
      } else if (req.method === "DELETE") {
        sql = `with r as (delete from public.${ident(table)} ${q.where} ${returning}) select coalesce(json_agg(r), '[]') as r from r`;
      } else return send(res, 405, {});
      const r = await asRole(claims, (c) => c.query(sql, params));
      const rows = r.rows[0].r;
      if (req.method !== "GET" && !wantReturn) return send(res, 201, undefined);
      return respond(rows);
    } catch (e) {
      return pgError(res, e);
    }
  }

  // ---------------- Auth ----------------
  function userJson(u) {
    return { id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  }
  function issue(u) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const refresh = crypto.randomBytes(16).toString("hex");
    sessions.set(refresh, u);
    return {
      access_token: signJwt({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, exp }),
      token_type: "bearer",
      expires_in: 3600,
      expires_at: exp,
      refresh_token: refresh,
      user: userJson(u),
    };
  }
  async function auth(req, res, url, sub) {
    if (sub === "token") {
      const body = JSON.parse((await readBody(req)).toString());
      if (url.searchParams.get("grant_type") === "password") {
        const u = users.find((x) => x.email === body.email && x.password === body.password);
        if (!u) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", msg: "Invalid login credentials", code: "invalid_credentials" });
        return send(res, 200, issue(u));
      }
      const u = sessions.get(body.refresh_token);
      if (!u) return send(res, 400, { error: "invalid_grant", msg: "Invalid Refresh Token" });
      return send(res, 200, issue(u));
    }
    const claims = verifyJwt(req.headers.authorization?.replace(/^Bearer /i, ""));
    const u = claims && users.find((x) => x.id === claims.sub);
    if (sub === "user" && req.method === "GET") return u ? send(res, 200, userJson(u)) : send(res, 401, { msg: "invalid JWT" });
    if (sub === "user" && req.method === "PUT") {
      if (!u) return send(res, 401, { msg: "invalid JWT" });
      const body = JSON.parse((await readBody(req)).toString());
      if (body.password) u.password = body.password;
      return send(res, 200, userJson(u));
    }
    if (sub === "logout") return send(res, 204, undefined);
    if (sub === "recover") return send(res, 200, {});
    return send(res, 404, { msg: "not supported in e2e mock" });
  }

  // ---------------- Storage ----------------
  const filePath = (bucket, name) => {
    const p = path.join(storageDir, bucket, name);
    if (!p.startsWith(path.join(storageDir, bucket) + path.sep)) throw new Error("bad path");
    return p;
  };
  const meta = new Map(); // bucket/name → content-type
  async function bucketInfo(id) {
    const r = await pool.query("select public from storage.buckets where id = $1", [id]);
    return r.rows[0] ?? null;
  }
  function signStorage(bucket, name, exp) {
    const payload = Buffer.from(JSON.stringify({ url: `${bucket}/${name}`, exp })).toString("base64url");
    return `${payload}.${crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url")}`;
  }
  async function storage(req, res, url, sub) {
    const parts = sub.split("/").map(decodeURIComponent);
    // GET /object/public/:bucket/:path
    if (req.method === "GET" && parts[0] === "object" && parts[1] === "public") {
      const [bucket, ...rest] = parts.slice(2);
      const info = await bucketInfo(bucket);
      if (!info || !info.public) return send(res, 400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
      const name = rest.join("/");
      const p = filePath(bucket, name);
      if (!fs.existsSync(p)) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
      return send(res, 200, fs.readFileSync(p), { "Content-Type": meta.get(`${bucket}/${name}`) ?? "application/octet-stream" });
    }
    // GET /object/sign/:bucket/:path?token=
    if (req.method === "GET" && parts[0] === "object" && parts[1] === "sign") {
      const [bucket, ...rest] = parts.slice(2);
      const name = rest.join("/");
      const token = url.searchParams.get("token") ?? "";
      const [payload, sig] = token.split(".");
      const ok =
        sig && crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url") === sig &&
        (() => {
          const p = JSON.parse(Buffer.from(payload, "base64url").toString());
          return p.url === `${bucket}/${name}` && p.exp * 1000 > Date.now();
        })();
      if (!ok) return send(res, 400, { statusCode: "403", error: "InvalidJWT", message: "invalid signature or expired" });
      return send(res, 200, fs.readFileSync(filePath(bucket, name)), { "Content-Type": meta.get(`${bucket}/${name}`) ?? "application/octet-stream" });
    }
    // GET /object/:bucket/:path（需要授權的直接下載）→ 以使用者身分查 storage.objects（RLS）
    if (req.method === "GET" && parts[0] === "object") {
      const [bucket, ...rest] = parts.slice(1);
      const name = rest.join("/");
      const claims = claimsFrom(req);
      const r = await asRole(claims, (c) => c.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, name])).catch(() => ({ rows: [] }));
      if (r.rows.length === 0) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
      return send(res, 200, fs.readFileSync(filePath(bucket, name)));
    }
    // POST /object/sign/:bucket  { expiresIn, paths }（只有 service_role 可用）
    if (req.method === "POST" && parts[0] === "object" && parts[1] === "sign") {
      const claims = claimsFrom(req);
      if (claims.role !== "service_role") return send(res, 400, { statusCode: "403", message: "not allowed" });
      const bucket = parts[2];
      const body = JSON.parse((await readBody(req)).toString());
      const exp = Math.floor(Date.now() / 1000) + body.expiresIn;
      return send(
        res,
        200,
        body.paths.map((p) => ({ path: p, error: null, signedURL: `/object/sign/${bucket}/${p}?token=${signStorage(bucket, p, exp)}` })),
      );
    }
    // POST /object/:bucket/:path 上傳 → 以使用者身分寫入 storage.objects（RLS）
    if (req.method === "POST" && parts[0] === "object") {
      const [bucket, ...rest] = parts.slice(1);
      const name = rest.join("/");
      const claims = claimsFrom(req);
      const raw = await readBody(req);
      const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: raw }).formData();
      let file = null;
      for (const [, v] of form) if (typeof v !== "string") file = v;
      if (!file) return send(res, 400, { message: "no file" });
      const info = await pool.query("select file_size_limit, allowed_mime_types from storage.buckets where id = $1", [bucket]);
      const b = info.rows[0];
      if (!b) return send(res, 400, { statusCode: "404", message: "Bucket not found" });
      if (b.allowed_mime_types && !b.allowed_mime_types.includes(file.type)) return send(res, 400, { statusCode: "415", message: "mime type not supported" });
      if (b.file_size_limit && file.size > Number(b.file_size_limit)) return send(res, 400, { statusCode: "413", message: "Payload too large" });
      try {
        await asRole(claims, (c) => c.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, name, claims.sub ?? null]));
      } catch (e) {
        return send(res, 400, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
      }
      const p = filePath(bucket, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(await file.arrayBuffer()));
      meta.set(`${bucket}/${name}`, file.type);
      return send(res, 200, { Key: `${bucket}/${name}`, Id: crypto.randomUUID() });
    }
    // DELETE /object/:bucket { prefixes }
    if (req.method === "DELETE" && parts[0] === "object") {
      const bucket = parts[1];
      const claims = claimsFrom(req);
      const body = JSON.parse((await readBody(req)).toString());
      const r = await asRole(claims, (c) =>
        c.query("delete from storage.objects where bucket_id = $1 and name = any($2) returning name", [bucket, body.prefixes]),
      ).catch(() => ({ rows: [] }));
      for (const row of r.rows) fs.rmSync(filePath(bucket, row.name), { force: true });
      return send(res, 200, r.rows.map((x) => ({ name: x.name, bucket_id: bucket })));
    }
    return send(res, 404, { message: "not supported in e2e mock" });
  }

  // ---------------- Functions：正式 download 函式 ----------------
  const fnDeps = {
    tokenSecret: TOKEN_SECRET,
    allowedOrigins: [],
    async verifyPassword(password, clientHash) {
      const r = await asRole({ role: "service_role" }, (c) => c.query("select public.verify_download_password($1, $2) as r", [password, clientHash]));
      return r.rows[0].r;
    },
    async downloadState() {
      const r = await asRole({ role: "service_role" }, (c) => c.query("select public.download_state() as r"));
      return r.rows[0].r;
    },
    async monthlyPublic() {
      const r = await asRole({ role: "service_role" }, (c) => c.query("select monthly_public from public.site_settings where id = 1"));
      return r.rows[0].monthly_public;
    },
    async listImages(ids) {
      const r = await asRole({ role: "service_role" }, (c) =>
        c.query(
          `select id, title, original_path, plain_original_path, mime_type, file_size::int, sort_order, is_published, is_downloadable, is_monthly
             from public.images where is_published and is_downloadable ${ids ? "and id::text = any($1)" : ""}`,
          ids ? [ids] : [],
        ),
      );
      return r.rows;
    },
    async signUrls(paths, expiresIn) {
      const exp = Math.floor(Date.now() / 1000) + expiresIn;
      return paths.map((p) => `http://127.0.0.1:${port}/storage/v1/object/sign/originals/${p}?token=${signStorage("originals", p, exp)}`);
    },
    async recordDownloads(ids, kind) {
      await asRole({ role: "service_role" }, (c) => c.query("select public.record_downloads($1::uuid[], $2)", [ids, kind]));
    },
  };

  async function functions(req, res, sub) {
    if (sub !== "download") return send(res, 404, {});
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", req.socket.remoteAddress ?? "unknown");
    const response = await handle(new Request(`http://127.0.0.1:${port}/functions/v1/download`, { method: req.method, headers, body }), fnDeps);
    const buf = Buffer.from(await response.arrayBuffer());
    const h = {};
    response.headers.forEach((v, k) => (h[k] = v));
    res.writeHead(response.status, h);
    res.end(buf);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS" && !req.url.startsWith("/functions/")) return send(res, 200, "ok");
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const m = /^\/(rest|auth|storage|functions)\/v1\/(.*)$/.exec(url.pathname);
      if (!m) return send(res, 404, { message: "not found" });
      const [, svc, sub] = m;
      if (svc === "rest") return await rest(req, res, url, sub);
      if (svc === "auth") return await auth(req, res, url, sub);
      if (svc === "storage") return await storage(req, res, url, sub);
      if (svc === "functions") return await functions(req, res, sub);
    } catch (e) {
      console.error("mock error", e);
      send(res, 500, { message: String(e.message) });
    }
  });

  return {
    ANON_KEY,
    SERVICE_KEY,
    pool,
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", r)),
    close: async () => {
      server.close();
      await pool.end();
    },
  };
}
