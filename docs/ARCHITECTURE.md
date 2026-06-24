# Switchboard — Architecture

> Conceptual overview of the seven components and the single tool-call data flow. For the
> **as-built**, module-by-module breakdown (every file in `src/`, the exact config contract, and
> what's proven vs. roadmap), see **[BLUEPRINT.md](BLUEPRINT.md)**.

## Components

```
                         ┌─────────────────────────────────────────────┐
   agent clients ──MCP──▶│  GATEWAY  (the single MCP server agents hit)  │
   (Claude/Cursor/...)   │   stdio + Streamable HTTP                     │
                         │                                              │
                         │   ┌──────────────┐   ┌────────────────────┐  │
                         │   │ POLICY ENGINE │   │  TOOL ROUTER /      │  │
                         │   │ read/write/   │──▶│  TOOL-SEARCH        │  │
                         │   │ full + gates  │   │ (namespacing/filter)│  │
                         │   └──────────────┘   └─────────┬──────────┘  │
                         │            ▲                    │             │
                         │   ┌────────┴────────┐   ┌───────▼──────────┐  │
                         │   │ CREDENTIAL VAULT │   │ SERVER REGISTRY  │  │
                         │   │ (AES-256-GCM file)│   │ mounted upstream │  │
                         │   └─────────────────┘   │ MCP servers      │  │
                         │                          └───────┬──────────┘  │
                         └──────────────────────────────────┼─────────────┘
                                                            │
                    ┌──────────────┬─────────────┬──────────┴───────┐
              stdio/npx          remote HTTP    app2mcp-generated   ...
              (github MCP)       (slack MCP)    (OpenAPI spec → MCP)

   DASHBOARD (local web UI) ──HTTP──▶ Gateway control plane
   (toggle ON/OFF, set scopes, view audit log, copy the MCP URL)
```

### 1. Gateway (`src/gateway.ts`)
The MCP server every agent connects to. Exposes **stdio** (for local clients like Claude Desktop)
and **Streamable HTTP** (for remote/web agents). It is a *proxy*: it presents a single tool
surface and forwards calls to mounted upstream servers after policy checks.

### 2. Server Registry (`src/registry.ts`)
The set of mounted upstream MCP servers, one SDK `Client` each. Source types:
- `npx` / `binary` — launch a local MCP server process (stdio).
- `remote` — connect to a hosted MCP server over Streamable HTTP.
- `app2mcp` — a server we **generate** in-process from an OpenAPI/Swagger spec (`src/openapi.ts`),
  linked via the SDK's `InMemoryTransport` — no extra process. **Shipped (Phase 4).** A reference
  without a resolvable spec still fails closed.

### 3. Credential Vault (`src/vault.ts`)
Local, encrypted-at-rest store for API keys and tokens. Backend = a passphrase-free
**AES-256-GCM encrypted file** in `~/.switchboard` (each secret sealed with its own IV + auth tag,
using Node's built-in `crypto` — **zero native dependencies**), or `env` to read straight from the
process environment. Config holds only `${vault:name}` / `${env:NAME}` references, resolved at
mount time. **Credentials never go over the network to us — there is no "us."**

### 4. Policy Engine (`src/policy.ts`) — the governance layer
Every tool call is classified and checked:
- **Scope:** `read` < `write` < `full`. Default = least privilege (`default_policy`, starter = `read`).
- **Scope inference:** tool names map to a scope by verb (`get/list/read…`→read, `delete/drop/revoke…`→full, else write).
- **Per-tool overrides:** block `delete_repo`, allow `create_issue`, etc.
- **Approval gates:** `write`/`full` calls can require an interactive human confirm
  (`src/approval.ts`, fail-closed — the same CMD-vs-EXE separation idea applied to MCP tools).
- **Audit log:** append-only record of every call + verdict (`src/audit.ts`).

### 5. Tool Router / Tool-Search (`src/router.ts`) — the scaling fix
Naive aggregation = 30 servers × ~20 tools = ~600 tools dumped into the agent's context →
selection accuracy collapses + tokens explode. Three configurable modes (`gateway.tool_exposure`):
- **`namespaced`** (default) — tools prefixed `github__create_issue`; only ENABLED servers exposed.
- **`flat`** — raw passthrough (small setups only).
- **`search`** — expose two meta-tools, **`find_tools(query)`** + **`call_tool(name, arguments)`**;
  the agent searches, Switchboard returns only the relevant handful. The endgame for large catalogs.

### 6. Dashboard (`src/dashboard.ts` + `src/console.ts`)
Local web UI (the "operator console"). Lists servers, **ON/OFF** toggles (mount/unmount live + persist
to config), sets scopes, shows the audit log, and surfaces the **MCP URL to copy** into agent clients.
It is a single self-contained vanilla-JS HTML document served by the gateway — no React, no bundler.

### 7. app2mcp Generator (`src/openapi.ts`) — *shipped (Phase 4)*
`spec → MCP server`, generated **in-process** at mount and linked to the gateway via the SDK's
`InMemoryTransport` (no child process, no FastMCP dependency). OpenAPI 3.x **and** Swagger 2.0 are
parsed; each operation becomes a tool with a JSON-Schema input derived from its parameters + request
body, and a `base_url` override covers relative/host-less specs. Scopes are inferred from the HTTP
verb (`GET/HEAD/OPTIONS/TRACE`→read, `POST/PUT/PATCH`→write, `DELETE`→full) and flow into the **same**
policy engine as every other server — a generated `deletepet` is denied under a `read` ceiling, proven
live. Auth headers resolve from the vault at call time. **Honest limit:** needs a spec or a describable
API — no spec, no magic; a reference without a resolvable spec still fails closed.

## As-built stack

- **Gateway + CLI:** TypeScript / Node, ESM (`"type": "module"`, NodeNext). MCP's SDK is first-class
  in TS and most MCP servers ship as npm packages → mounting `npx` servers is native. Run from source
  today (`node dist/cli.js …`); `npm`-published `switchboard` binary is a later step.
- **Dashboard:** a single embedded HTML document (`src/console.ts`), vanilla JS, served locally by the
  gateway. No React, no Vite, no build step for the UI.
- **State:** the human-editable `switchboard.config.yaml` is the source of truth (zod-validated on
  load). No database — the audit log is a JSON-lines file. *(SQLite was considered and rejected to keep
  zero native deps.)*
- **Vault:** an AES-256-GCM encrypted file via Node's built-in `crypto`. *(`keytar`/OS-keychain was
  considered and rejected — it pulls a native dependency; the encrypted file is portable and toolchain-free.)*
- **Config:** `switchboard.config.yaml` (human-editable; the dashboard writes back to it).

## Key data flow (a single tool call)

1. Agent calls `github__create_issue` on the gateway.
2. Gateway → Router → Policy Engine: server `github` enabled? tool not blocked? inferred scope
   (`write`) ≤ the server's ceiling? approval required for this scope?
3. If an approval gate is set → prompt the human (`approve()`), default no; deny if non-interactive.
4. The verdict is written to the append-only audit log.
5. On *allow*, the registry's `github` client forwards the call (with `GITHUB_TOKEN` already injected
   from the vault at mount time) and the upstream result is returned to the agent.

A blocked `delete_repo` is denied and audited at step 2 — it never reaches the upstream server.
