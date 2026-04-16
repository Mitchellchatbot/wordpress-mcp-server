import express, { Request, Response } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── WordPress API client ────────────────────────────────────────────────────

const WP_BASE_URL = (process.env.WP_BASE_URL ?? "").replace(/\/$/, "");
const WP_USERNAME = process.env.WP_USERNAME ?? "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD ?? "";
const MCP_API_TOKEN = process.env.MCP_API_TOKEN ?? "";

function authHeader(): string {
  const credentials = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");
  return `Basic ${credentials}`;
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
    for (const [k, v] of Object.entries(queryParams)) {
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader(),
  };
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WordPress API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ─── Webhook submission store (in-memory) ────────────────────────────────────

interface Submission {
  id: string;
  received_at: string;
  form_name: string;
  page_url: string;
  fields: Record<string, string>;
}

const submissions: Submission[] = [];
const MAX_SUBMISSIONS = 500; // keep last 500 submissions in memory

// ─── MCP server factory ──────────────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer({
    name: "miami-outpatient-wordpress-mcp",
    version: "2.0.0",
  });

  // ── Pages ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_pages",
    "List all pages on the WordPress site. Returns ID, title, slug, and status.",
    {
      per_page: z.number().min(1).max(100).optional().describe("Number of pages to return (default 20)"),
      status: z.enum(["publish", "draft", "private", "any"]).optional().describe("Filter by status (default: any)"),
      search: z.string().optional().describe("Search pages by keyword"),
    },
    async ({ per_page = 20, status = "any", search }) => {
      const params: Record<string, string | number | boolean> = { per_page, status };
      if (search) params.search = search;
      const data = await wpRequest("/pages", "GET", undefined, params);
      const pages = data as Array<{ id: number; title: { rendered: string }; slug: string; status: string; link: string; date: string }>;
      return { content: [{ type: "text", text: JSON.stringify(pages.map(p => ({ id: p.id, title: p.title.rendered, slug: p.slug, status: p.status, url: p.link, date: p.date })), null, 2) }] };
    }
  );

  server.tool(
    "get_page",
    "Get the full content of a single WordPress page by its ID.",
    { id: z.number().describe("The WordPress page ID") },
    async ({ id }) => {
      const data = await wpRequest(`/pages/${id}`) as { id: number; title: { rendered: string }; content: { rendered: string; raw?: string }; excerpt: { rendered: string }; slug: string; status: string; link: string; date: string; modified: string };
      return { content: [{ type: "text", text: JSON.stringify({ id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, date: data.date, modified: data.modified, excerpt: data.excerpt.rendered, content: data.content.raw ?? data.content.rendered }, null, 2) }] };
    }
  );

  server.tool(
    "update_page",
    "Update the title and/or content of a WordPress page.",
    {
      id: z.number().describe("The WordPress page ID to update"),
      title: z.string().optional().describe("New page title"),
      content: z.string().optional().describe("New page content in HTML"),
      excerpt: z.string().optional().describe("New page excerpt"),
      status: z.enum(["publish", "draft", "private"]).optional().describe("New page status"),
    },
    async ({ id, title, content, excerpt, status }) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (excerpt !== undefined) body.excerpt = excerpt;
      if (status !== undefined) body.status = status;
      const data = await wpRequest(`/pages/${id}`, "POST", body) as { id: number; title: { rendered: string }; slug: string; status: string; link: string; modified: string };
      return { content: [{ type: "text", text: JSON.stringify({ success: true, id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, modified: data.modified }, null, 2) }] };
    }
  );

  // ── Posts ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_posts",
    "List blog posts on the WordPress site.",
    {
      per_page: z.number().min(1).max(100).optional().describe("Number of posts to return (default 20)"),
      status: z.enum(["publish", "draft", "private", "any"]).optional().describe("Filter by status"),
      search: z.string().optional().describe("Search posts by keyword"),
    },
    async ({ per_page = 20, status = "any", search }) => {
      const params: Record<string, string | number | boolean> = { per_page, status };
      if (search) params.search = search;
      const data = await wpRequest("/posts", "GET", undefined, params);
      const posts = data as Array<{ id: number; title: { rendered: string }; slug: string; status: string; link: string; date: string }>;
      return { content: [{ type: "text", text: JSON.stringify(posts.map(p => ({ id: p.id, title: p.title.rendered, slug: p.slug, status: p.status, url: p.link, date: p.date })), null, 2) }] };
    }
  );

  server.tool(
    "get_post",
    "Get the full content of a single WordPress post by its ID.",
    { id: z.number().describe("The WordPress post ID") },
    async ({ id }) => {
      const data = await wpRequest(`/posts/${id}`) as { id: number; title: { rendered: string }; content: { rendered: string; raw?: string }; excerpt: { rendered: string }; slug: string; status: string; link: string; date: string; modified: string };
      return { content: [{ type: "text", text: JSON.stringify({ id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, date: data.date, modified: data.modified, excerpt: data.excerpt.rendered, content: data.content.raw ?? data.content.rendered }, null, 2) }] };
    }
  );

  server.tool(
    "update_post",
    "Update the title, content, or excerpt of a WordPress post.",
    {
      id: z.number().describe("The WordPress post ID to update"),
      title: z.string().optional().describe("New post title"),
      content: z.string().optional().describe("New post content in HTML"),
      excerpt: z.string().optional().describe("New post excerpt"),
      status: z.enum(["publish", "draft", "private"]).optional().describe("New post status"),
    },
    async ({ id, title, content, excerpt, status }) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (excerpt !== undefined) body.excerpt = excerpt;
      if (status !== undefined) body.status = status;
      const data = await wpRequest(`/posts/${id}`, "POST", body) as { id: number; title: { rendered: string }; slug: string; status: string; link: string; modified: string };
      return { content: [{ type: "text", text: JSON.stringify({ success: true, id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, modified: data.modified }, null, 2) }] };
    }
  );

  server.tool(
    "create_post",
    "Create a new WordPress blog post.",
    {
      title: z.string().describe("Post title"),
      content: z.string().describe("Post content in HTML"),
      excerpt: z.string().optional().describe("Post excerpt"),
      status: z.enum(["publish", "draft", "private"]).optional().describe("Post status (default: draft)"),
    },
    async ({ title, content, excerpt, status = "draft" }) => {
      const body: Record<string, unknown> = { title, content, status };
      if (excerpt) body.excerpt = excerpt;
      const data = await wpRequest("/posts", "POST", body) as { id: number; title: { rendered: string }; slug: string; status: string; link: string; date: string };
      return { content: [{ type: "text", text: JSON.stringify({ success: true, id: data.id, title: data.title.rendered, slug: data.slug, status: data.status, url: data.link, date: data.date }, null, 2) }] };
    }
  );

  // ── Taxonomy & Media ──────────────────────────────────────────────────────

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

  // ── Webhook / Form Submissions ────────────────────────────────────────────

  server.tool(
    "list_form_submissions",
    "List Elementor form submissions received via webhook. Returns all fields submitted by users (name, email, phone, message, etc.).",
    {
      limit: z.number().min(1).max(100).optional().describe("Number of submissions to return (default 50)"),
      form_name: z.string().optional().describe("Filter by form name"),
      search: z.string().optional().describe("Search across all field values e.g. an email or name"),
      after: z.string().optional().describe("Return submissions after this date e.g. 2024-01-01"),
    },
    async ({ limit = 50, form_name, search, after }) => {
      let results = [...submissions];

      if (form_name) {
        results = results.filter(s => s.form_name.toLowerCase().includes(form_name.toLowerCase()));
      }
      if (after) {
        const afterDate = new Date(after);
        results = results.filter(s => new Date(s.received_at) >= afterDate);
      }
      if (search) {
        const q = search.toLowerCase();
        results = results.filter(s =>
          Object.values(s.fields).some(v => v.toLowerCase().includes(q)) ||
          s.form_name.toLowerCase().includes(q)
        );
      }

      results = results.slice(0, limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_stored: submissions.length,
            returned: results.length,
            submissions: results,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_form_submission",
    "Get a single form submission by its ID.",
    { id: z.string().describe("The submission ID") },
    async ({ id }) => {
      const sub = submissions.find(s => s.id === id);
      if (!sub) return { content: [{ type: "text", text: JSON.stringify({ error: "Submission not found" }) }] };
      return { content: [{ type: "text", text: JSON.stringify(sub, null, 2) }] };
    }
  );

  server.tool(
    "get_form_names",
    "List all unique form names that have submitted via webhook.",
    {},
    async () => {
      const names = [...new Set(submissions.map(s => s.form_name))].sort();
      return { content: [{ type: "text", text: JSON.stringify({ form_names: names, total_submissions: submissions.length }, null, 2) }] };
    }
  );

  // ── Site info ─────────────────────────────────────────────────────────────

  server.tool("get_site_info", "Get basic information about the WordPress site.", {}, async () => {
    const url = `${WP_BASE_URL}/wp-json`;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    const data = await res.json() as { name: string; description: string; url: string; home: string; gmt_offset: number; timezone_string: string };
    return { content: [{ type: "text", text: JSON.stringify({ name: data.name, description: data.description, url: data.url, home: data.home, timezone: data.timezone_string }, null, 2) }] };
  });

  return server;
}

// ─── Express HTTP server ─────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function isAuthorized(req: Request): boolean {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret) return true;
  const auth = req.headers.authorization ?? "";
  return auth === `Bearer ${secret}`;
}

// ── Webhook endpoint — Elementor posts here on every form submission ──────────
app.post("/webhook", (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;

    // Log raw payload so we can inspect what Elementor actually sends
    console.log("Webhook raw payload:", JSON.stringify(body, null, 2));

    const metaKeys = new Set(["form_id", "form_name", "referer", "page_url", "queried_id", "element_id", "actions", "ip", "referrer", "remote_ip", "submitted_on"]);

    const fields: Record<string, string> = {};

    // Format 1: Elementor sends a nested "fields" array [{id, title, value}]
    if (Array.isArray(body.fields)) {
      for (const f of body.fields as Array<{ id?: string; title?: string; value?: string }>) {
        const key = f.title ?? f.id ?? "field";
        fields[key] = String(f.value ?? "");
      }
    }
    // Format 2: Elementor sends fields as flat key/value on the body
    else {
      for (const [key, val] of Object.entries(body)) {
        if (!metaKeys.has(key) && key !== "fields") {
          fields[key] = String(val ?? "");
        }
      }
    }

    // Form name — try multiple possible keys Elementor uses
    const formName =
      String(body.form_name ?? body["form-name"] ?? body.form_id ?? "").trim() || "Unknown Form";

    // Page URL
    const pageUrl = String(body.referer ?? body.page_url ?? body.referrer ?? "");

    const submission: Submission = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      received_at: new Date().toISOString(),
      form_name: formName,
      page_url: pageUrl,
      fields,
    };

    // Store submission
    submissions.unshift(submission);
    if (submissions.length > MAX_SUBMISSIONS) submissions.splice(MAX_SUBMISSIONS);

    console.log(`Webhook received: ${submission.form_name} — ${JSON.stringify(fields)}`);

    res.json({ success: true, id: submission.id });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Failed to process webhook" });
  }
});

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.all("/mcp", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "miami-outpatient-wordpress-mcp", submissions_stored: submissions.length });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Miami Outpatient WordPress MCP server listening on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`MCP endpoint:     http://localhost:${PORT}/mcp`);
});
