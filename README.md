# miami-outpatient-wordpress-mcp

A Model Context Protocol (MCP) server that connects Claude AI to the Miami Outpatient Detox WordPress site. Allows Claude to read and update pages, posts, and Elementor Pro form submissions directly via the WordPress REST API.

---

## What This Does

Once deployed, Claude can:

- **Read & edit pages and posts** — view content, update copy, change titles, update excerpts
- **Create new draft posts** — write and stage blog content
- **Browse media, categories, and tags**
- **Read Elementor Pro form submissions (leads)** — view all fields submitted by users (name, email, phone, message, etc.)
- **Search and filter leads** — by form name, date range, or keyword

---

## Project Structure

```
miami-outpatient-wordpress-mcp/
├── src/
│   └── index.ts                      # MCP server — all tools defined here
├── plugin/
│   └── elementor-submissions-api.php # WordPress plugin — install on the WP site
├── Dockerfile                        # Docker build (used by Railway)
├── railway.toml                      # Railway deployment config
├── package.json
├── tsconfig.json
├── .env.example                      # Environment variable reference
└── .gitignore
```

---

## Prerequisites

- [Railway](https://railway.app) account
- WordPress.org site with:
  - Elementor Pro installed (for form submissions)
  - Application Passwords enabled (built into WP 5.6+)
- Node.js 22+ (for local development only)

---

## Setup: Step by Step

### 1. Generate a WordPress Application Password

1. Log into `wp-admin` → go to **Users → Your Profile**
2. Scroll to **Application Passwords**
3. Enter name `Claude MCP` → click **Add New Application Password**
4. Copy the generated password (shown only once) — it looks like `AbCd EfGh IjKl MnOp QrSt UvWx`

### 2. Install the WordPress Plugin

The `plugin/elementor-submissions-api.php` file adds a custom REST endpoint that exposes Elementor Pro form submissions.

1. In `wp-admin` go to **Plugins → Add New → Upload Plugin**
2. Upload `elementor-submissions-api.php` and activate it
3. Verify it works by visiting (while logged into WP):
   ```
   https://your-site.com/wp-json/custom/v1/form-names
   ```
   You should see a JSON list of your Elementor form names.

### 3. Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. Select this repo — Railway auto-detects the `Dockerfile`
4. Go to **Variables** and add:

   | Variable | Value |
   |---|---|
   | `WP_BASE_URL` | `https://miamioutpatientdetox.com` |
   | `WP_USERNAME` | your WordPress username |
   | `WP_APP_PASSWORD` | the password from Step 1 (spaces included) |
   | `MCP_AUTH_TOKEN` | optional — leave blank for open access |
   | `PORT` | set automatically by Railway |

5. Go to **Settings → Networking → Generate Domain**
6. Test the health endpoint:
   ```
   https://your-railway-url.up.railway.app/health
   ```
   Expected response: `{"status":"ok","service":"miami-outpatient-wordpress-mcp"}`

### 4. Connect to Claude.ai

1. Go to [claude.ai](https://claude.ai) → **Settings → Integrations**
2. Click **Add Integration**
3. Enter:
   - **Name:** `WordPress - Miami Outpatient`
   - **URL:** `https://your-railway-url.up.railway.app/mcp`
4. Save — Claude now has access to all tools below

---

## Available MCP Tools

### Pages
| Tool | Description |
|---|---|
| `list_pages` | List all pages with ID, title, slug, status |
| `get_page` | Get full content of a page by ID |
| `update_page` | Update title, content, excerpt, or status |

### Posts
| Tool | Description |
|---|---|
| `list_posts` | List posts with filtering by status or category |
| `get_post` | Get full content of a post by ID |
| `update_post` | Update title, content, excerpt, or status |
| `create_post` | Create a new post (defaults to draft) |

### Taxonomy & Media
| Tool | Description |
|---|---|
| `list_categories` | List all categories |
| `list_tags` | List all tags |
| `list_media` | Browse the media library |

### Elementor Form Submissions
| Tool | Description |
|---|---|
| `list_form_names` | List all unique Elementor form names |
| `list_form_submissions` | List leads with all submitted field values |
| `get_form_submission` | Get a single submission by ID (marks as read) |

### Site
| Tool | Description |
|---|---|
| `get_site_info` | Get site name, description, timezone, and REST API namespaces |

---

## Example Claude Prompts

```
List all the pages on the WordPress site
```
```
Show me the content of the About page
```
```
Update the hero text on the Home page to say "..."
```
```
Show me all Elementor form submissions from this week
```
```
Find any leads who submitted the Contact form and include their email and phone
```
```
Create a draft blog post titled "..." with the following content: ...
```

---

## Local Development

```bash
cp .env.example .env
# Fill in your values in .env

npm install
npm run dev
```

Server runs at `http://localhost:3000/mcp`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `WP_BASE_URL` | ✅ | WordPress site URL, no trailing slash |
| `WP_USERNAME` | ✅ | WordPress username |
| `WP_APP_PASSWORD` | ✅ | WordPress Application Password |
| `MCP_AUTH_TOKEN` | ❌ | Optional bearer token to protect the `/mcp` endpoint |
| `PORT` | ❌ | Port to listen on (Railway sets this automatically) |

---

## Adding More WordPress Sites

Deploy a separate instance of this server on Railway for each site, with its own `WP_BASE_URL`, `WP_USERNAME`, and `WP_APP_PASSWORD` environment variables. Add each Railway URL as a separate integration in Claude.ai.
