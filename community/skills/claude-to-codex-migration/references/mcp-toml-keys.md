# MCP: `.mcp.json` -> `~/.codex/config.toml [mcp_servers.<id>]`

Codex MCP servers are declared as TOML tables in the **host-global** `~/.codex/config.toml`,
NOT in any per-agent file. This is a SCOPE change (per-agent repo file -> host-shared
config) as well as a format change. MERGE the tables; NEVER overwrite the file (it is
shared by all codex agents on the host).

Example (placeholder host/token — substitute your own):
```toml
[mcp_servers.example-remote]
url = "https://your-mcp-server.example.com/mcp"
bearer_token_env_var = "EXAMPLE_MCP_TOKEN"
```

## Each server is EITHER stdio OR HTTP

A server sets EITHER `command` (stdio) OR `url` (streamable HTTP). Never both.

### HTTP / remote server
| key | meaning |
|---|---|
| `url` | the MCP endpoint (presence of `url` implies HTTP transport) |
| `bearer_token_env_var` | **HTTP-only.** Name of the env var holding the bearer token. The token is REFERENCED, never inlined. |

### stdio / local server
| key | meaning |
|---|---|
| `command` | the binary to spawn |
| `args` | array of CLI args |
| `env` | env vars for the process. Canonical TOML form is a sub-table `[mcp_servers.<id>.env]` with `KEY = "VALUE"` lines (per OpenAI docs). Inline `env = { KEY = "VALUE" }` is valid TOML too, but prefer the sub-table to match the docs. |
| `cwd` | working directory |
| `enabled` | bool |
| `startup_timeout_sec` | startup timeout in seconds (alias: `startup_timeout_ms`) |
| `tool_timeout_sec` | per-tool timeout in seconds |
| `required` | bool — fail startup if this server can't start |
| `enabled_tools` | array — allowlist of tool names |
| `disabled_tools` | array — denylist of tool names |
| `default_tools_approval_mode` | `auto` \| `prompt` \| `approve` |

## Translating a Claude `.mcp.json` entry

Claude form (per-agent JSON):
```json
{ "mcpServers": {
  "supabase": { "type":"http", "url":"https://mcp.supabase.com/mcp?...", "headers":{"Authorization":"Bearer sbp_..."} }
}}
```
becomes:
```toml
[mcp_servers.supabase]
url = "https://mcp.supabase.com/mcp?..."
bearer_token_env_var = "SUPABASE_MCP_TOKEN"
```
and a NEEDS-HUMAN task: add `SUPABASE_MCP_TOKEN=<secret>` to `orgs/<org>/secrets.env`
(or shell profile). The secret value cannot be auto-migrated into config.toml by design.

For a Claude stdio entry `{ "command": "...", "args": [...], "env": {...} }`, write (env as a sub-table, per OpenAI docs):
```toml
[mcp_servers.<id>]
command = "..."
args = ["..."]

[mcp_servers.<id>.env]
KEY = "VALUE"
```

## Hard constraints
- **Host-global name collision is a HARD STOP.** Codex MCP names are host-wide, NOT
  `<agent>__`-namespaced like skills. Two agents with a `supabase` server collide in
  one config.toml. A human must resolve before convert.
- **Secrets never land in config.toml.** Always `bearer_token_env_var` indirection.
- **Empty `.mcp.json` is a no-op** — report "no MCP servers to migrate."
