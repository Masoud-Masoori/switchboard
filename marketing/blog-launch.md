# Switchboard: a local-first, governed MCP gateway that lets Claude *and* ChatGPT share the same tools

> **TL;DR — What is Switchboard?** Switchboard is a free, open-source (Apache-2.0), local-first MCP (Model Context Protocol) aggregator and proxy. You run one local process that re-exposes all of your MCP servers behind one governed endpoint, so both Claude and ChatGPT — plus Cursor, Claude Code, VS Code, and your own agents — reach the same tools through the same encrypted local vault, the same on/off + read/write/full policy, the same approval gates, and the same audit log. Your API keys live in a local AES-256-GCM vault on your machine (zero token custody), it can run fully offline against a local LLM, and there is no per-call meter. It is a **working alpha** from MAS-AI Technologies. Install with `npm install -g mcp-switchboard` (Node ≥ 18.18), or run it with no install via `npx mcp-switchboard serve`. Repo: https://github.com/Masoud-Masoori/switchboard

---

## The problem

You have two of the best agents in the world — Claude and ChatGPT — and you want them to actually *do things*: read your GitHub, triage your Gmail, update Notion, ping Slack, hit your internal REST API. The Model Context Protocol (MCP) is how agents reach those tools, and the ecosystem already has thousands of MCP servers.

But connecting them is painful in two specific ways.

**First, the wiring is N×M.** Every client (Claude Desktop, Claude Code, Cursor, VS Code, ChatGPT, your own agents) has to be wired to every app (GitHub, Gmail, Notion, Slack, your API) by hand. Add a new tool and you edit every client's JSON config. Add a new client and you re-wire every tool. The matrix grows multiplicatively.

**Second, the "easy" hosted shortcut parks your OAuth tokens on someone else's server.** Hosted tool routers will happily wire everything up for you — but in exchange they custody your credentials and meter your calls. Your keys live in their cloud; your usage runs through their billing.

There is a third, quieter problem that shows up once you mount more than a handful of servers: **context blow-up**. Mount 30 servers and naive aggregation dumps roughly 600 tool schemas into your agent's context window. Accuracy collapses and tokens explode.

Switchboard exists to solve all three on your own machine.

## What Switchboard is

Switchboard is a **self-hosted MCP gateway** — an MCP aggregator and local MCP proxy that collapses **N×M into N×1**. You run one local process that re-exposes all your MCP servers behind one governed endpoint. You add that endpoint **once** as a connector in Claude and **once** in ChatGPT, and now both assistants reach the same tools through:

- the **same encrypted vault** for credentials,
- the **same on/off + read/write/full policy**,
- the **same approval gates**, and
- the **same append-only audit log**.

One control plane. Your machine. No "us" in the middle.

Think of it as your own private "Connectors" page — the kind ChatGPT and Claude each ship as a walled garden — except it lives on *your* box, mounts the *whole* MCP ecosystem instead of a curated shortlist, and serves *every* assistant at once.

```
     Claude Desktop ─┐                            ┌─ Gmail        (read)
     Claude Code  ───┤       ┌────────────┐       ├─ GitHub       (write · delete blocked)
     claude.ai web ──┼─ MCP ▶│ SWITCHBOARD │▶──────┼─ Notion       (read)
     ChatGPT      ───┤       │ vault·policy│       ├─ Slack        (OFF)
     Cursor/agents ──┘       │ ·audit·gates│       ├─ your REST API (app2mcp)
                             └────────────┘       └─ a local LLM   (offline council)
```

One important clarification, because people ask: this is a shared **control plane, not a shared session.** Claude and ChatGPT do not see each other's chats or share conversation state. What they share is the layer *underneath* — one set of bring-your-own credentials, one policy, one audit trail. Both can act on your Gmail, each governed identically and every call logged in one place, but neither inherits the other's context.

## How it works

Every call an agent makes flows through the same governed path:

```
   agent clients ──MCP──▶  GATEWAY  ──▶  ROUTER ──▶ POLICY ENGINE ──▶ REGISTRY ──▶ upstream
   (stdio + HTTP)          one server     namespaced/    read<write<     mounted     MCP servers
                                          flat/search    full + gates    clients     (npx / remote)
                                              │              │              ▲
                                          DASHBOARD       AUDIT LOG       VAULT
                                          (toggle/scope)  (append-only)   (AES-256-GCM, local)
```

A call is classified as `read`, `write`, or `full`, checked against the server's scope ceiling and any per-tool override, optionally held for human approval, then forwarded — and **every verdict is written to an append-only audit log.**

A few mechanics worth knowing:

- **Local clients connect directly; cloud clients need a door.** Anything running on your machine — Claude Desktop, Claude Code, Cursor, your own agents — reaches `127.0.0.1` directly with an API key, zero extra setup. Anything running in a vendor's cloud — claude.ai web and ChatGPT's custom connectors — *cannot* reach your laptop's localhost. For those, run `switchboard expose` to get a public HTTPS URL and turn on the built-in **OAuth 2.1 + PKCE** authorization server, then paste that URL as the connector and authorize once. Same governed endpoint, reachable from the cloud, still zero token custody.

- **Secrets are references, never literals.** Your config never contains a raw key. Secret fields accept *only* `${vault:..}`, `${env:..}`, or `${oauth:..}` references, which Switchboard resolves locally at mount time. The encrypted secret itself lives in the local vault.

- **Three tool-exposure modes keep context from exploding.** Set `gateway.tool_exposure` to:
  - **`namespaced`** (default) — tools prefixed like `github__create_issue`; only enabled servers exposed.
  - **`flat`** — bare tool names, for small setups.
  - **`search`** — expose just two meta-tools, `find_tools(query)` and `call_tool(name, args)`. The agent searches; Switchboard returns only the relevant handful. The surface stays flat no matter how many servers you mount.

Beyond the core path, Switchboard ships a set of extras you would normally only get from a hosted router — except these run on your own hardware: per-client **profiles**, **rate limits and spend budgets**, a per-server **circuit breaker**, decision **webhooks**, poll-first **triggers**, request/response **modifiers**, HTTP-to-MCP tool servers, and **OpenAPI→MCP** import via `app2mcp`.

## Why local-first matters

The defensible idea behind Switchboard is not the catalog — hosted players already have big catalogs. It is the combination of **local credentials + a governance layer + a usable dashboard**, built as an aggregator that rides the existing MCP ecosystem instead of re-implementing it.

**Your tokens never leave your machine.** Bring-your-own keys live in a local **AES-256-GCM** vault at `~/.switchboard/vault.json`, encrypted with a key in `~/.switchboard/vault.key`. The vault makes no network calls. Nothing is parked on a vendor server. Even for the five managed OAuth providers (Google, GitHub, Slack, Notion, Linear), you authorize once via a local loopback flow and the token is sealed in that same local vault — it never leaves your box.

**Governance fails closed.** A disabled server, an over-ceiling scope, or an unverifiable approval context all result in *deny*, not a silent allow. Rate limits and spend budgets fail closed too: hit the ceiling and the call is denied and logged, never silently dropped.

**You can run it with no cloud account at all.** Switchboard's cross-provider "council" can point at an auto-detected **local LLM** — Ollama, LM Studio, llama.cpp, or vLLM — for a second-opinion / debate model with zero cloud, zero keys, and nothing leaving the box. `switchboard local-llm` auto-detects a running OpenAI-compatible server, and `switchboard local-llm wire` writes the keyless provider block for you. It only ever *reads* — it auto-detects a server you started yourself and never downloads or runs a model for you, by design.

**It binds to localhost by default.** The HTTP endpoint and the embedded dashboard bind to **127.0.0.1** — local-first, not exposed to the network unless you explicitly choose to expose it.

## How it compares to hosted tool routers

Hosted tool routers (for example, Composio and Pipedream) are genuinely good hosted SaaS. The honest framing is not "they are bad" — it is that they make a different trade. They custody your tokens and meter your calls. Switchboard keeps keys, governance, and audit on *your* machine, and it is free and open source. Frame it as **the self-hosted, governed alternative.**

| | Switchboard | Hosted tool routers |
|---|---|---|
| **One connector, every assistant** | Add it once; Claude *and* ChatGPT share the same governed tools | Per-vendor, per-app setup |
| **Where your tokens live** | A local AES-256-GCM vault on **your** machine | Their cloud |
| **Integrations** | Mounts existing MCP servers — no treadmill | Hand-built, must be maintained |
| **One-command setup** | `switchboard install <client>` wires it into a client | Copy-paste JSON per client |
| **Governance** | Per-tool `read/write/full` + approval gates + audit log | Usually all-or-nothing |
| **Profiles** | Named views — a locked-down "demo" vs a full "dev" surface, one switch | None |
| **Rate limits + spend budgets** | Per-minute/hour/day call *and* cost ceilings, fail-closed | Pay the overage |
| **Resilience** | Per-server circuit breaker trips a flapping upstream, fast-fails | Hangs propagate |
| **Works offline** | Council runs against an auto-detected local LLM — no account required | Cloud-only |
| **Context blow-up** | `search` mode → 2 meta-tools no matter how many servers | Dump every tool into context |
| **Cost** | Free, Apache-2.0, self-hosted, no per-call meter | Metered SaaS |

The net-new tier — profiles, spend budgets, and a circuit breaker — is the part a metered cloud structurally can't sell you, because it runs on your own hardware and answers to your own failure policy.

## Quickstart

You need **Node 18.18 or newer**. That's the only prerequisite.

**Install from npm (recommended):**

```bash
npm install -g mcp-switchboard   # installs the `switchboard` command globally
switchboard init                 # scaffold a config + the ~/.switchboard home directory
switchboard serve                # stdio for local clients + HTTP endpoint & dashboard
```

**Zero install:**

```bash
npx mcp-switchboard serve
```

Then open the embedded dashboard at **http://127.0.0.1:8088** (it binds to localhost by default) and point an agent at the MCP endpoint.

**Wire a client in one command.** `switchboard install <client>` writes the right config block, in the right file, for the client you name — Claude Desktop, Claude Code, Cursor, VS Code, or Codex — so you never hand-edit JSON:

```bash
switchboard install claude-code           # project-local config in the current dir
switchboard install claude-desktop --global   # the client's user/global config
switchboard install cursor --print        # preview the exact block without writing it
```

It is non-destructive: it merges into the client's existing servers and never clobbers them, and `--print` shows you exactly what it would write first.

**Store a secret (bring your own keys).** Secrets never appear in your config — the config holds only `${vault:name}` references:

```bash
printf '%s' 'ghp_xxx' | switchboard vault set github_pat
switchboard vault list      # names only, never values
```

**Browse and connect.** The dashboard ships a browsable catalog of **4,700+** MCP servers and HTTP toolkits, built from the open MCP Registry and APIs.guru (both CC0). Search it, flip one on, and wire it into a client with `switchboard install <client>` — no account, no allowlist.

## Roadmap & alpha status (honest)

**Switchboard is a working alpha.** Please read that plainly: it is not production-ready, not battle-tested, and not enterprise-grade. It just launched — there are zero GitHub stars, no known production users, and no benchmarks against named competitors. Treat it as early software and kick the tires accordingly.

That said, here is what is real and verified *today*: the aggregating gateway (stdio + Streamable HTTP), the policy engine, all three tool-exposure modes, the encrypted vault, the approval gate, the audit log, the dashboard, the CLI, and one-command `install` into five clients. The full `find_tools → call_tool` round-trip works end-to-end through the governed path. Shipped phases also include managed OAuth for five providers, `app2mcp` (OpenAPI→MCP), the cross-provider council, claude.ai-web / ChatGPT OAuth 2.1 + PKCE, decision webhooks, and poll-first triggers — plus the "beyond hosted parity" tier (profiles, rate limits + spend budgets, circuit breaker, browsable catalog, and BM25F search mode).

**On engineering discipline:** Switchboard is pure-TypeScript/Node ESM with exactly **5 runtime dependencies**, **zero native dependencies**, and a one-command install. Every governance and honesty claim is backed by a **deterministic verification oracle** — a zero-dependency Node script that imports the compiled code, exercises the contract, and prints `N/N checks passed`. `npm run verify` runs the build plus all twenty-five oracles, **~1,150 automated checks** in total. That's code checking code, no model tokens, no flakiness — which is exactly the bar an alpha should hold itself to before asking you to trust it with your keys.

Criticism is wanted. If something is wrong, missing, or overstated, please open an issue or a PR.

## FAQ

**Is Switchboard free?**
Yes. It is free, self-hosted, and licensed under Apache-2.0, with no per-call meter. You run it on your own hardware.

**Does Switchboard custody my keys?**
No. There is zero token custody. Bring-your-own keys live in a local AES-256-GCM vault on your machine (`~/.switchboard/vault.json`), and the vault makes no network calls. Your config never holds a raw secret — secret fields accept only `${vault:..}`, `${env:..}`, or `${oauth:..}` references. Even managed OAuth tokens are sealed in that same local vault and never leave your machine.

**Does it work with ChatGPT?**
Yes. Switchboard is one control plane for both Claude and ChatGPT. Local clients (Claude Desktop, Claude Code, Cursor, your own agents) hit `127.0.0.1` directly. Cloud clients — claude.ai web and ChatGPT's custom connectors — reach it via `switchboard expose` plus the built-in OAuth 2.1 / PKCE authorization server: expose a public HTTPS URL, paste it as a custom connector, and authorize once.

**Can it run offline?**
Yes. The cross-provider council can run against an auto-detected local LLM — Ollama, LM Studio, llama.cpp, or vLLM — with no account and no API key required. `switchboard local-llm` auto-detects a running OpenAI-compatible server and `switchboard local-llm wire` writes the keyless provider block. Nothing leaves the box. (Switchboard reads only — it never downloads or runs a model for you.)

**What does it require?**
Node.js 18.18 or newer. That's it. Install with `npm install -g mcp-switchboard` then `switchboard init && switchboard serve`, or run with no install via `npx mcp-switchboard serve`.

**How is it different from Composio or Pipedream?**
Composio and Pipedream are good hosted SaaS, but they custody your tokens and meter your calls. Switchboard is the self-hosted, governed alternative: keys, governance, and audit stay on your machine; it mounts the existing MCP ecosystem rather than re-implementing integrations; it serves both Claude and ChatGPT through one governed endpoint; and it is free and Apache-2.0 with no per-call meter. It also adds profiles, spend budgets, and a per-server circuit breaker that run on your own hardware.

**Is Switchboard production-ready?**
No — it is a working alpha. It just launched with no known production users. Every feature is pinned by a deterministic verification oracle (~1,150 automated checks), but you should still treat it as early software.

---

**Switchboard** — local-first, governed MCP aggregator / proxy. Apache-2.0, by MAS-AI Technologies (Masoud Masoori).
Repo: https://github.com/Masoud-Masoori/switchboard · Install: `npm install -g mcp-switchboard` · CLI: `switchboard` · Dashboard: http://127.0.0.1:8088

*Keywords: MCP aggregator, MCP gateway, self-hosted MCP, local MCP proxy, MCP server for Claude and ChatGPT.*
