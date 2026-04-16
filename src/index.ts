import express, { Request, Response } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── WordPress API client ────────────────────────────────────────────────────

const WP_BASE_URL = (process.env.WP_BASE_URL ?? "").replace(/\/$/, "");
const WP_USERNAME = process.env.WP_USERNAME ?? "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD ?? "";

// Basic auth header from username + application password
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
  if (!res.ok) {
    throw new Error(`WordPress API error ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// ─── MCP server factory ──────────────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer({
    name: "miami-outpatient-wordpress-mcp",
    version: "1.0.0",
  });

  // ── Pages ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_pages",
    "List all pages on the WordPress site. Returns ID, title, slug, and status.",
    {
      per_page: z.number().min(1).max(100).optional().describe("Number of pages to return (default 20)"),
      status: z.enum(["publish", "draft", "private", "any"]).optional().describe("Filter by status (default: publish)"),
      search: z.string().optional().describe("Search pages by keyword"),
    },
    async ({ per_page = 20, status = "any", search }) => {
      const params: Record<string, string | number | boolean> = { per_page, status };
      if (search) params.search = search;
      const data = await wpRequest("/pages", "GET", undefined, params);
      const pages = data as Array<{
        id: number;
        title: { rendered: string };
        slug: string;
        status: string;
        link: string;
        date: string;
      }>;
      const summary = pages.map((p) => ({
        id: p.id,
        title: p.title.rendered,
        slug: p.slug,
        status: p.status,
        url: p.link,
        date: p.date,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    "get_page",
    "Get the full content of a single WordPress page by its ID.",
    {
      id: z.number().describe("The WordPress page ID"),
    },
    async ({ id }) => {
      const data = await wpRequest(`/pages/${id}`) as {
        id: number;
        title: { rendered: string };
        content: { rendered: string; raw?: string };
        excerpt: { rendered: string };
        slug: string;
        status: string;
        link: string;
        date: string;
        modified: string;
      };
      const result = {
        id: data.id,
        title: data.title.rendered,
        slug: data.slug,
        status: data.status,
        url: data.link,
        date: data.date,
        modified: data.modified,
        excerpt: data.excerpt.rendered,
        content: data.content.raw ?? data.content.rendered,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "update_page",
    "Update the title and/or content of a WordPress page. Use this to make copy/content changes.",
    {
      id: z.number().describe("The WordPress page ID to update"),
      title: z.string().optional().describe("New page title (leave out to keep existing)"),
      content: z.string().optional().describe("New page content in HTML (leave out to keep existing)"),
      excerpt: z.string().optional().describe("New page excerpt (leave out to keep existing)"),
      status: z.enum(["publish", "draft", "private"]).optional().describe("New page status (leave out to keep existing)"),
    },
    async ({ id, title, content, excerpt, status }) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (excerpt !== undefined) body.excerpt = excerpt;
      if (status !== undefined) body.status = status;

      const data = await wpRequest(`/pages/${id}`, "POST", body) as {
        id: number;
        title: { rendered: string };
        slug: string;
        status: string;
        link: string;
        modified: string;
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            id: data.id,
            title: data.title.rendered,
            slug: data.slug,
            status: data.status,
            url: data.link,
            modified: data.modified,
          }, null, 2),
        }],
      };
    }
  );

  // ── Posts ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_posts",
    "List blog posts on the WordPress site. Returns ID, title, slug, status, and date.",
    {
      per_page: z.number().min(1).max(100).optional().describe("Number of posts to return (default 20)"),
      status: z.enum(["publish", "draft", "private", "any"]).optional().describe("Filter by status (default: publish)"),
      search: z.string().optional().describe("Search posts by keyword"),
      categories: z.string().optional().describe("Comma-separated category IDs to filter by"),
    },
    async ({ per_page = 20, status = "any", search, categories }) => {
      const params: Record<string, string | number | boolean> = { per_page, status };
      if (search) params.search = search;
      if (categories) params.categories = categories;
      const data = await wpRequest("/posts", "GET", undefined, params);
      const posts = data as Array<{
        id: number;
        title: { rendered: string };
        slug: string;
        status: string;
        link: string;
        date: string;
        categories: number[];
      }>;
      const summary = posts.map((p) => ({
        id: p.id,
        title: p.title.rendered,
        slug: p.slug,
        status: p.status,
        url: p.link,
        date: p.date,
        categories: p.categories,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    "get_post",
    "Get the full content of a single WordPress post by its ID.",
    {
      id: z.number().describe("The WordPress post ID"),
    },
    async ({ id }) => {
      const data = await wpRequest(`/posts/${id}`) as {
        id: number;
        title: { rendered: string };
        content: { rendered: string; raw?: string };
        excerpt: { rendered: string };
        slug: string;
        status: string;
        link: string;
        date: string;
        modified: string;
        categories: number[];
        tags: number[];
      };
      const result = {
        id: data.id,
        title: data.title.rendered,
        slug: data.slug,
        status: data.status,
        url: data.link,
        date: data.date,
        modified: data.modified,
        excerpt: data.excerpt.rendered,
        content: data.content.raw ?? data.content.rendered,
        categories: data.categories,
        tags: data.tags,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

      const data = await wpRequest(`/posts/${id}`, "POST", body) as {
        id: number;
        title: { rendered: string };
        slug: string;
        status: string;
        link: string;
        modified: string;
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            id: data.id,
            title: data.title.rendered,
            slug: data.slug,
            status: data.status,
            url: data.link,
            modified: data.modified,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "create_post",
    "Create a new WordPress blog post.",
    {
      title: z.string().describe("Post title"),
      content: z.string().describe("Post content in HTML"),
      excerpt: z.string().optional().describe("Post excerpt/summary"),
      status: z.enum(["publish", "draft", "private"]).optional().describe("Post status (default: draft)"),
      categories: z.array(z.number()).optional().describe("Array of category IDs"),
    },
    async ({ title, content, excerpt, status = "draft", categories }) => {
      const body: Record<string, unknown> = { title, content, status };
      if (excerpt) body.excerpt = excerpt;
      if (categories) body.categories = categories;

      const data = await wpRequest("/posts", "POST", body) as {
        id: number;
        title: { rendered: string };
        slug: string;
        status: string;
        link: string;
        date: string;
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            id: data.id,
            title: data.title.rendered,
            slug: data.slug,
            status: data.status,
            url: data.link,
            date: data.date,
          }, null, 2),
        }],
      };
    }
  );

  // ── Categories & Tags ─────────────────────────────────────────────────────

  server.tool(
    "list_categories",
    "List all categories on the WordPress site.",
    {
      per_page: z.number().min(1).max(100).optional().describe("Number of categories to return (default 50)"),
    },
    async ({ per_page = 50 }) => {
      const data = await wpRequest("/categories", "GET", undefined, { per_page });
      const cats = data as Array<{ id: number; name: string; slug: string; count: number }>;
      return {
        content: [{
          type: "text",
          text: JSON.stringify(cats.map((c) => ({ id: c.id, name: c.name, slug: c.slug, post_count: c.count })), null, 2),
        }],
      };
    }
  );

  server.tool(
    "list_tags",
    "List all tags on the WordPress site.",
    {
      per_page: z.number().min(1).max(100).optional().describe("Number of tags to return (default 50)"),
    },
    async ({ per_page = 50 }) => {
      const data = await wpRequest("/tags", "GET", undefined, { per_page });
      const tags = data as Array<{ id: number; name: string; slug: string; count: number }>;
      return {
        content: [{
          type: "text",
          text: JSON.stringify(tags.map((t) => ({ id: t.id, name: t.name, slug: t.slug, post_count: t.count })), null, 2),
        }],
      };
    }
  );

  // ── Media ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_media",
    "List media files in the WordPress media library.",
    {
      per_page: z.number().min(1).max(100).optional().describe("Number of media items to return (default 20)"),
      media_type: z.enum(["image", "video", "audio", "application"]).optional().describe("Filter by media type"),
      search: z.string().optional().describe("Search media by keyword"),
    },
    async ({ per_page = 20, media_type, search }) => {
      const params: Record<string, string | number | boolean> = { per_page };
      if (media_type) params.media_type = media_type;
      if (search) params.search = search;
      const data = await wpRequest("/media", "GET", undefined, params);
      const items = data as Array<{
        id: number;
        title: { rendered: string };
        slug: string;
        source_url: string;
        media_type: string;
        mime_type: string;
        date: string;
      }>;
      return {
        content: [{
          type: "text",
          text: JSON.stringify(items.map((m) => ({
            id: m.id,
            title: m.title.rendered,
            slug: m.slug,
            url: m.source_url,
            type: m.media_type,
            mime: m.mime_type,
            date: m.date,
          })), null, 2),
        }],
      };
    }
  );


  // ── Elementor Form Submissions ───────────────────────────────────────────

  server.tool(
    "list_form_names",
    "List all unique Elementor form names on the site. Use this first to know what forms exist before querying submissions.",
    {},
    async () => {
      const url = `${WP_BASE_URL}/wp-json/custom/v1/form-names`;
      const res = await fetch(url, { headers: { Authorization: authHeader() } });
      const text = await res.text();
      if (!res.ok) throw new Error(`WordPress API error ${res.status}: ${text}`);
      return { content: [{ type: "text", text: text }] };
    }
  );

  server.tool(
    "list_form_submissions",
    "List Elementor Pro form submissions (leads). Returns all field values submitted by users.",
    {
      per_page: z.number().min(1).max(100).optional().describe("Number of submissions to return (default 20)"),
      page: z.number().min(1).optional().describe("Page number for pagination (default 1)"),
      form_name: z.string().optional().describe("Filter by form name — use list_form_names to get available names"),
      search: z.string().optional().describe("Search across all field values e.g. an email or name"),
      after: z.string().optional().describe("Return submissions after this datetime format: 2024-01-01 00:00:00"),
    },
    async ({ per_page = 20, page = 1, form_name, search, after }) => {
      const params: Record<string, string | number | boolean> = { per_page, page };
      if (form_name) params.form_name = form_name;
      if (search) params.search = search;
      if (after) params.after = after;
      const url = new URL(`${WP_BASE_URL}/wp-json/custom/v1/form-submissions`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const res = await fetch(url.toString(), { headers: { Authorization: authHeader() } });
      const text = await res.text();
      if (!res.ok) throw new Error(`WordPress API error ${res.status}: ${text}`);
      return { content: [{ type: "text", text: text }] };
    }
  );

  server.tool(
    "get_form_submission",
    "Get full details of a single Elementor form submission by its ID. Also marks it as read.",
    {
      id: z.number().describe("The submission ID"),
    },
    async ({ id }) => {
      const url = `${WP_BASE_URL}/wp-json/custom/v1/form-submissions/${id}`;
      const res = await fetch(url, { headers: { Authorization: authHeader() } });
      const text = await res.text();
      if (!res.ok) throw new Error(`WordPress API error ${res.status}: ${text}`);
      return { content: [{ type: "text", text: text }] };
    }
  );

  // ── Site info ─────────────────────────────────────────────────────────────

  server.tool(
    "get_site_info",
    "Get basic information about the WordPress site (name, description, URL, etc.).",
    {},
    async () => {
      const url = `${WP_BASE_URL}/wp-json`;
      const res = await fetch(url, { headers: { Authorization: authHeader() } });
      const data = await res.json() as {
        name: string;
        description: string;
        url: string;
        home: string;
        gmt_offset: number;
        timezone_string: string;
        namespaces: string[];
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: data.name,
            description: data.description,
            url: data.url,
            home: data.home,
            timezone: data.timezone_string,
            gmt_offset: data.gmt_offset,
            api_namespaces: data.namespaces,
          }, null, 2),
        }],
      };
    }
  );

  return server;
}

// ─── Express HTTP server ─────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

function isAuthorized(req: Request): boolean {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret) return true; // no auth configured — open
  const auth = req.headers.authorization ?? "";
  return auth === `Bearer ${secret}`;
}

app.all("/mcp", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking needed
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
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "miami-outpatient-wordpress-mcp" });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`WordPress MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Connected to: ${WP_BASE_URL}`);
});
