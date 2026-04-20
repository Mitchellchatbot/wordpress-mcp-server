# WordPress MCP Server

Generic MCP server for WordPress sites. Handles Elementor form submissions (stored in Supabase) and WordPress content editing via the REST API.

## Deploy a new client

1. Create a new Railway service pointing to this repo
2. Set env vars (see below)
3. Run the Supabase schema SQL (see below)
4. Done

## Required env vars (set in Railway)

| Variable | Description |
|---|---|
| `DATABASE_URL` | Supabase connection string (same for all clients) |
| `DB_SCHEMA` | Supabase schema name e.g. `miami_outpatient`, `client2` |
| `WP_BASE_URL` | WordPress site URL e.g. `https://example.com` |
| `WP_USERNAME` | WordPress username |
| `WP_APP_PASSWORD` | WordPress application password |
| `MCP_AUTH_TOKEN` | Secret token to protect the /mcp endpoint |

## Supabase setup (once per new client)

Run this in Supabase SQL Editor (replace `your_schema_name`):

```sql
CREATE SCHEMA IF NOT EXISTS your_schema_name;
```

The server creates the `submissions` table automatically on first boot.

## Per-client code changes

Update these two maps in `src/index.ts` with the client's Elementor field IDs and form IDs:

```typescript
const FIELD_LABELS: Record<string, string> = {
  "field_id_here": "Human Label",
  ...
};

const FORM_NAMES: Record<string, string> = {
  "form_id_here": "Form Name",
};
```

Field IDs are found in Elementor → form widget → each field's Advanced tab → ID.
Form IDs are found in the Elementor form widget settings → Content tab → Form ID.

## Endpoints

- `POST /webhook` — Elementor posts form submissions here
- `ALL  /mcp`     — MCP endpoint (requires Bearer token)
- `GET  /health`  — Health check
