import express, { Request, Response } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dns from "dns";
import pkg from "pg";
const { Pool } = pkg;

// ─── ENV VARS (set these in Railway per deployment) ───────────────────────────
//
//   DATABASE_URL     Supabase connection string (same for all clients)
//   DB_SCHEMA        Supabase schema name e.g. "miami_outpatient", "client2"
//   WP_BASE_URL      WordPress site URL e.g. "https://miamioutpatientdetox.com"
//   WP_USERNAME      WordPress username
//   WP_APP_PASSWORD  WordPress application password
//   MCP_AUTH_TOKEN   Secret token to protect the /mcp endpoint
//   PORT             (set automatically by Railway)
//
// ─────────────────────────────────────────────────────────────────────────────

// Force IPv4 — Railway does not support IPv6 to Supabase
dns.setDefaultResultOrder("ipv4first");

// ─── Supabase / Postgres ──────────────────────────────────────────────────────

const DB_SCHEMA = (process.env.DB_SCHEMA ?? "public").replace(/[^a-z0-9_]/gi, "");
const T = `"${DB_SCHEMA}".submissions`;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb(): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS "${DB_SCHEMA}";
    CREATE TABLE IF NOT EXISTS ${T} (
      id          TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      form_name   TEXT NOT NULL DEFAULT 'Unknown Form',
      page_url    TEXT NOT NULL DEFAULT '',
      fields      JSONB NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS submissions_received_at_idx ON ${T} (received_at DESC);
    CREATE INDEX IF NOT EXISTS submissions_form_name_idx   ON ${T} (form_name);
  `);
  console.log(`Database initialised ✓ (schema: ${DB_SCHEMA})`);
}

// ─── WordPress API ────────────────────────────────────────────────────────────

const WP_BASE_URL = (process.env.WP_BASE_URL ?? "").replace(/\/$/, "");
const WP_USERNAME = process.env.WP_USERNAME ?? "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD ?? "";

function authHeader(): string {
  return `Basic ${Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64")}`;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function wpRequest(
  path: string,
  method: HttpMethod = "GET",
  body?: unknown,
  queryParams?: Record<string, string | number | boolean>
): Promise<unknown> {
  const url = new URL(`${WP_BASE_URL}/wp-json/wp/v2${path}`);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method,
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WordPress API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ─── Elementor field ID → human label map ────────────────────────────────────
// Update these per client with their Elementor field IDs
const FIELD_LABELS: Record<string, string> = {
  "email":         "First Name",
  "field_357e341": "Last Name",
  "field_e99ca9e": "Email",
  "field_07f0796": "Insurance Provider",
  "field_e806566": "Member ID/Policy Number",
  "field_6a07350": "Date of Birth",
};

function resolveFieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

// ─── Elementor form ID → human name map ──────────────────────────────────────
// Update these per client with their Elementor form IDs
const FORM_NAMES: Record<string, string> = {
  "f82804c": "Contact Form",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Submission {
  id: string;
  received_at: string;
  form_name: string;
  page_url: string;
  fields: Record<string, string>;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function insertSubmission(sub: Submission): Promise<void> {
  await pool.query(
    `INSERT INTO ${T} (id, received_at, form_name, page_url, fields)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [sub.id, sub.received_at, sub.form_name, sub.page_url, JSON.stringify(sub.fields)]
  );
}

async function querySubmissions(opts: {
  limit: number;
  form_name?: string;
  search?: string;
  after?: string;
}): Promise<{ total: number; rows: Submission[] }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (opts.form_name) { conditions.push(`form_name ILIKE $${i++}`); params.push(`%${opts.form_name}%`); }
  if (opts.after)     { conditions.push(`received_at >= $${i++}`);  params.push(opts.after); }
  if (opts.search) {
    conditions.push(`(fields::text ILIKE $${i} OR form_name ILIKE $${i + 1})`);
    params.push(`%${opts.search}%`, `%${opts.search}%`);
    i += 2;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countRes = await pool.query(`SELECT COUNT(*) FROM ${T} ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(opts.limit);
  const dataRes = await pool.query(
    `SELECT id, received_at, form_name, page_url, fields FROM ${T} ${where} ORDER BY received_at DESC LIMIT $${i}`,
    params
  );

  return {
    total,
    rows: dataRes.rows.map(r => ({
      id: r.id,
      received_at: r.received_at instanceof Date ? r.received_at.toISOString() : String(r.received_at),
      form_name: r.form_name,
      page_url: r.page_url,
      fields: typeof r.fields === "string" ? JSON.parse(r.fields) : r.fields,
    })),
  };
}

// ─── MCP server ───────────────────────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer({ name: "wordpress-mcp-server", version: "1.0.0" });

  // ── Pages ────────────────────────────────────────────────────────────────

  server.tool("list_pages", "List all pages on the WordPress site.", {
    per_page: z.number().min(1).max(100).optional().describe("Number of pages to return (default 20)"),
    status: z.enum(["publish", "draft", "private", "any"]).optional().describe("Filter by status (default: any)"),
    search: z.string().optional().describe("Search pages by keyword"),
  }, async ({ per_page = 20, status = "any", search }) => {
    const params: Record<string, string | number | boolean> = { per_page, status };
    if (search) params.search = search;
    const data = await wpRequest("/pages", "GET", undefined, params);
    const pages = data as Array<{ id: number; title: { rendered: string }; slug: string; status: string; link: string; date: string }>;
    return { content: [{ type: "text", text: JSON.stringify(pages.map(p => ({ id: p.id, title: p.title.rendered, slug: p.slug, status: p.status, url: p.link, date: p.date })), null, 2) }] };
  });

  server.tool("get_page", "Get the full content of a single WordPress page by its ID.", {
    id: z.number().describe("The WordPress page ID"),
  }, async ({ id }) => {
    const data = await wpRequest(`/pages/${id}`) as { id: number; title: { rendered: string }; content: { rendered: string; raw?: string }; excerpt: { rendered: string }; slug: string; status: string; link: string; date: string; modified: string };
    return { content: [{ type: "text", text: JSON.stringify({ id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, date: data.date, modified: data.modified, excerpt: data.excerpt.rendered, content: data.content.raw ?? data.content.rendered }, null, 2) }] };
  });

  server.tool("update_page", "Update the title and/or content of a WordPress page.", {
    id: z.number().describe("The WordPress page ID to update"),
    title: z.string().optional().describe("New page title"),
    content: z.string().optional().describe("New page content in HTML"),
    excerpt: z.string().optional().describe("New page excerpt"),
    status: z.enum(["publish", "draft", "private"]).optional().describe("New page status"),
  }, async ({ id, title, content, excerpt, status }) => {
    const body: Record<string, unknown> = {};
    if (title !== undefined) body.title = title;
    if (content !== undefined) body.content = content;
    if (excerpt !== undefined) body.excerpt = excerpt;
    if (status !== undefined) body.status = status;
    const data = await wpRequest(`/pages/${id}`, "POST", body) as { id: number; title: { rendered: string }; slug: string; status: string; link: string; modified: string };
    return { content: [{ type: "text", text: JSON.stringify({ success: true, id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, modified: data.modified }, null, 2) }] };
  });

  // ── Posts ────────────────────────────────────────────────────────────────

  server.tool("list_posts", "List blog posts on the WordPress site.", {
    per_page: z.number().min(1).max(100).optional().describe("Number of posts to return (default 20)"),
    status: z.enum(["publish", "draft", "private", "any"]).optional().describe("Filter by status"),
    search: z.string().optional().describe("Search posts by keyword"),
  }, async ({ per_page = 20, status = "any", search }) => {
    const params: Record<string, string | number | boolean> = { per_page, status };
    if (search) params.search = search;
    const data = await wpRequest("/posts", "GET", undefined, params);
    const posts = data as Array<{ id: number; title: { rendered: string }; slug: string; status: string; link: string; date: string }>;
    return { content: [{ type: "text", text: JSON.stringify(posts.map(p => ({ id: p.id, title: p.title.rendered, slug: p.slug, status: p.status, url: p.link, date: p.date })), null, 2) }] };
  });

  server.tool("get_post", "Get the full content of a single WordPress post by its ID.", {
    id: z.number().describe("The WordPress post ID"),
  }, async ({ id }) => {
    const data = await wpRequest(`/posts/${id}`) as { id: number; title: { rendered: string }; content: { rendered: string; raw?: string }; excerpt: { rendered: string }; slug: string; status: string; link: string; date: string; modified: string };
    return { content: [{ type: "text", text: JSON.stringify({ id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, date: data.date, modified: data.modified, excerpt: data.excerpt.rendered, content: data.content.raw ?? data.content.rendered }, null, 2) }] };
  });

  server.tool("update_post", "Update the title, content, or excerpt of a WordPress post.", {
    id: z.number().describe("The WordPress post ID to update"),
    title: z.string().optional().describe("New post title"),
    content: z.string().optional().describe("New post content in HTML"),
    excerpt: z.string().optional().describe("New post excerpt"),
    status: z.enum(["publish", "draft", "private"]).optional().describe("New post status"),
  }, async ({ id, title, content, excerpt, status }) => {
    const body: Record<string, unknown> = {};
    if (title !== undefined) body.title = title;
    if (content !== undefined) body.content = content;
    if (excerpt !== undefined) body.excerpt = excerpt;
    if (status !== undefined) body.status = status;
    const data = await wpRequest(`/posts/${id}`, "POST", body) as { id: number; title: { rendered: string }; slug: string; status: string; link: string; modified: string };
    return { content: [{ type: "text", text: JSON.stringify({ success: true, id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, modified: data.modified }, null, 2) }] };
  });

  server.tool("create_post", "Create a new WordPress blog post.", {
    title: z.string().describe("Post title"),
    content: z.string().describe("Post content in HTML"),
    excerpt: z.string().optional().describe("Post excerpt"),
    status: z.enum(["publish", "draft", "private"]).optional().describe("Post status (default: draft)"),
  }, async ({ title, content, excerpt, status = "draft" }) => {
    const body: Record<string, unknown> = { title, content, status };
    if (excerpt) body.excerpt = excerpt;
    const data = await wpRequest("/posts", "POST", body) as { id: number; title: { rendered: string }; slug: string; status: string; link: string; date: string };
    return { content: [{ type: "text", text: JSON.stringify({ success: true, id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, date: data.date }, null, 2) }] };
  });

  // ── Taxonomy & Media ─────────────────────────────────────────────────────

  server.tool("list_categories", "List all categories on the WordPress site.", { per_page: z.number().min(1).max(100).optional() }, async ({ per_page = 50 }) => {
    const data = await wpRequest("/categories", "GET", undefined, { per_page }) as Array<{ id: number; name: string; slug: string; count: number }>;
    return { content: [{ type: "text", text: JSON.stringify(data.map(c => ({ id: c.id, name: c.name, slug: c.slug, post_count: c.count })), null, 2) }] };
  });

  server.tool("list_tags", "List all tags on the WordPress site.", { per_page: z.number().min(1).max(100).optional() }, async ({ per_page = 50 }) => {
    const data = await wpRequest("/tags", "GET", undefined, { per_page }) as Array<{ id: number; name: string; slug: string; count: number }>;
    return { content: [{ type: "text", text: JSON.stringify(data.map(t => ({ id: t.id, name: t.name, slug: t.slug, post_count: t.count })), null, 2) }] };
  });

  server.tool("list_media", "List media files in the WordPress media library.", {
    per_page: z.number().min(1).max(100).optional(),
    search: z.string().optional(),
  }, async ({ per_page = 20, search }) => {
    const params: Record<string, string | number | boolean> = { per_page };
    if (search) params.search = search;
    const data = await wpRequest("/media", "GET", undefined, params) as Array<{ id: number; title: { rendered: string }; source_url: string; media_type: string; mime_type: string; date: string }>;
    return { content: [{ type: "text", text: JSON.stringify(data.map(m => ({ id: m.id, title: m.title.rendered, url: m.source_url, type: m.media_type, mime: m.mime_type, date: m.date })), null, 2) }] };
  });

  // ── Form Submissions ─────────────────────────────────────────────────────

  server.tool("list_form_submissions", "List Elementor form submissions stored in Supabase. Supports filtering, search, and pagination.", {
    limit: z.number().min(1).max(500).optional().describe("Number of submissions to return (default 50, max 500)"),
    form_name: z.string().optional().describe("Filter by form name"),
    search: z.string().optional().describe("Search across all field values e.g. an email or name"),
    after: z.string().optional().describe("Return submissions after this date e.g. 2024-01-01"),
  }, async ({ limit = 50, form_name, search, after }) => {
    const { total, rows } = await querySubmissions({ limit, form_name, search, after });
    return { content: [{ type: "text", text: JSON.stringify({ total_stored: total, returned: rows.length, submissions: rows }, null, 2) }] };
  });

  server.tool("get_form_submission", "Get a single form submission by its ID.", {
    id: z.string().describe("The submission ID"),
  }, async ({ id }) => {
    const res = await pool.query(`SELECT * FROM ${T} WHERE id = $1`, [id]);
    if (res.rows.length === 0) return { content: [{ type: "text", text: JSON.stringify({ error: "Submission not found" }) }] };
    const r = res.rows[0];
    return { content: [{ type: "text", text: JSON.stringify({ id: r.id, received_at: r.received_at instanceof Date ? r.received_at.toISOString() : r.received_at, form_name: r.form_name, page_url: r.page_url, fields: typeof r.fields === "string" ? JSON.parse(r.fields) : r.fields }, null, 2) }] };
  });

  server.tool("get_form_names", "List all unique form names with submission counts.", {}, async () => {
    const res = await pool.query(`SELECT form_name, COUNT(*) as count FROM ${T} GROUP BY form_name ORDER BY form_name`);
    const total = res.rows.reduce((sum: number, r: { count: string }) => sum + parseInt(r.count, 10), 0);
    return { content: [{ type: "text", text: JSON.stringify({ form_names: res.rows.map((r: { form_name: string; count: string }) => ({ name: r.form_name, count: parseInt(r.count, 10) })), total_submissions: total }, null, 2) }] };
  });

  // ── Site info ────────────────────────────────────────────────────────────

  server.tool("get_site_info", "Get basic information about the WordPress site.", {}, async () => {
    const res = await fetch(`${WP_BASE_URL}/wp-json`, { headers: { Authorization: authHeader() } });
    const data = await res.json() as { name: string; description: string; url: string; home: string; timezone_string: string };
    return { content: [{ type: "text", text: JSON.stringify({ name: data.name, description: data.description, url: data.url, home: data.home, timezone: data.timezone_string }, null, 2) }] };
  });

  return server;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function isAuthorized(req: Request): boolean {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret) return true;
  return req.headers.authorization === `Bearer ${secret}`;
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post("/webhook", async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    console.log("Webhook raw payload:", JSON.stringify(body, null, 2));

    const fields: Record<string, string> = {};

    // Format 0: Zapier — sends everything as a stringified JSON blob under body.fields
    // e.g. { fields: '{"fields[email][value]":"John","form[name]":"Contact Form",...}' }
    if (typeof body.fields === "string") {
      try {
        const parsed = JSON.parse(body.fields) as Record<string, string>;

        // Extract form name from form[name]
        const zapFormName = parsed["form[name]"] ?? "";
        const zapFormId = parsed["form[id]"] ?? "";
        if (zapFormName) (body as Record<string, unknown>)["_zap_form_name"] = zapFormName;
        if (zapFormId)   (body as Record<string, unknown>)["_zap_form_id"]   = zapFormId;

        // Extract page URL from meta[page_url][value]
        const zapPageUrl = parsed["meta[page_url][value]"] ?? "";
        if (zapPageUrl) (body as Record<string, unknown>)["_zap_page_url"] = zapPageUrl;

        // Extract fields — keys like fields[email][value], use fields[email][title] as label
        const fieldValues: Record<string, string> = {};
        const fieldTitles: Record<string, string> = {};
        for (const [key, val] of Object.entries(parsed)) {
          const valueMatch = key.match(/^fields\[([^\]]+)\]\[value\]$/);
          const titleMatch = key.match(/^fields\[([^\]]+)\]\[title\]$/);
          if (valueMatch) fieldValues[valueMatch[1]] = val;
          if (titleMatch) fieldTitles[titleMatch[1]] = val;
        }
        for (const [id, value] of Object.entries(fieldValues)) {
          const label = fieldTitles[id] ?? resolveFieldLabel(id);
          fields[label] = value;
        }
      } catch {
        // not valid JSON, fall through to other formats
      }
    }
    // Format 1: Elementor standard — form_fields flat object
    else if (body.form_fields && typeof body.form_fields === "object" && !Array.isArray(body.form_fields)) {
      for (const [key, val] of Object.entries(body.form_fields as Record<string, unknown>)) {
        fields[resolveFieldLabel(key)] = String(val ?? "");
      }
    }
    // Format 2: fields object with {value, label} per field
    else if (typeof body.fields !== "string" && body.fields && !Array.isArray(body.fields) && typeof body.fields === "object") {
      for (const [key, val] of Object.entries(body.fields as Record<string, unknown>)) {
        if (val && typeof val === "object") {
          const obj = val as Record<string, unknown>;
          fields[String(obj.title ?? obj.label ?? resolveFieldLabel(key))] = String(obj.value ?? "");
        } else {
          fields[resolveFieldLabel(key)] = String(val ?? "");
        }
      }
    }
    // Format 3: fields array [{id, title, value}]
    else if (Array.isArray(body.fields)) {
      for (const f of body.fields as Array<Record<string, unknown>>) {
        const rawKey = String(f.id ?? "");
        const label = resolveFieldLabel(rawKey) !== rawKey ? resolveFieldLabel(rawKey) : String(f.title ?? f.label ?? f.id ?? "field");
        fields[label] = String(f.value ?? "");
      }
    }
    // Format 4: flat body fallback
    else {
      const metaKeys = new Set(["form_id", "form_name", "referer", "page_url", "queried_id", "element_id", "actions", "ip", "referrer", "remote_ip", "submitted_on", "form_fields", "post_id", "referer_title"]);
      for (const [key, val] of Object.entries(body)) {
        if (!metaKeys.has(key)) fields[resolveFieldLabel(key)] = typeof val === "object" ? JSON.stringify(val) : String(val ?? "");
      }
    }

    // Extract form name — supports Zapier (_zap_form_name), Elementor (body.form.name), and flat (body.form_name)
    const formObj = body.form as Record<string, unknown> | undefined;
    const rawFormId = String(body["_zap_form_id"] ?? formObj?.id ?? body.form_id ?? "");
    const formName =
      String(body["_zap_form_name"] ?? "").trim() ||
      String(formObj?.name ?? "").trim() ||
      FORM_NAMES[rawFormId] ||
      String(body.form_name ?? body["form-name"] ?? "").trim() ||
      rawFormId ||
      "Unknown Form";

    // Extract page URL — supports Zapier (_zap_page_url), Elementor (body.meta.page_url.value), and flat
    const metaObj = body.meta as Record<string, unknown> | undefined;
    const pageUrlObj = metaObj?.page_url as Record<string, unknown> | undefined;
    const pageUrl =
      String(body["_zap_page_url"] ?? "").trim() ||
      String(pageUrlObj?.value ?? "").trim() ||
      String(body.referer ?? body.page_url ?? body.referrer ?? "");

    const submission: Submission = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      received_at: new Date().toISOString(),
      form_name: formName,
      page_url: pageUrl,
      fields,
    };

    await insertSubmission(submission);
    console.log(`Saved to "${DB_SCHEMA}": ${submission.form_name} — ${JSON.stringify(fields)}`);
    res.json({ success: true, id: submission.id });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Failed to process webhook" });
  }
});

// ── MCP ───────────────────────────────────────────────────────────────────────
app.all("/mcp", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const countRes = await pool.query(`SELECT COUNT(*) FROM ${T}`).catch(() => ({ rows: [{ count: "?" }] }));
  res.json({ status: "ok", schema: DB_SCHEMA, submissions_stored: countRes.rows[0].count });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3000);
initDb()
  .then(() => app.listen(PORT, () => {
    console.log(`WordPress MCP server running on port ${PORT}`);
    console.log(`Schema: ${DB_SCHEMA}`);
    console.log(`Webhook: http://localhost:${PORT}/webhook`);
    console.log(`MCP:     http://localhost:${PORT}/mcp`);
  }))
  .catch(err => { console.error("DB init failed:", err); process.exit(1); });
