# MCP Switchboard Launch Readiness

Date: 2026-06-29  
Status: ready to launch after operator approval for outward-facing actions.

## Verified

- `npm run verify` is green: TypeScript build, low-severity `npm audit`, and all 26 deterministic oracle scripts.
- `npm audit --audit-level=low` found 0 vulnerabilities.
- Independent `ai-qa-loop` repo profile: 7/7 invariants covered, 6 HELD, 0 BREACHED, 1 INCONCLUSIVE. The inconclusive item is a fixture-looking token in `scripts/verify-vault.mjs`, not a live secret finding.
- Package dry run creates `mcp-switchboard-0.1.0.tgz` with `server.json`, README, compiled CLI, and embedded catalog included.
- Consumer install smoke passed from the packed tarball: `switchboard --help`, `mcp-switchboard --help`, module exports, and local uninstall all worked.
- Runtime smoke passed: dashboard health, catalog stats, toolkit detail, add-disabled-toolkit flow, playground tools, and `/mcp initialize` over HTTP.
- Codex integration smoke passed: global Codex config contains `mcp_servers.switchboard` at `http://127.0.0.1:8088/mcp`; a Streamable HTTP MCP client listed and called tools from two mounted servers through that endpoint; both calls were audited.
- Vault oracle passed: AES-256-GCM, random 12-byte IV, auth-tag verification, fail-closed missing refs, no plaintext secret in on-disk vault.
- Catalog oracle passed, including shipped-catalog rejection of templated/invalid remote mount URLs.
- Registry metadata oracle passed, including `mcpName`, `server.json`, npm package entry, stdio transport, and `serve` package argument.
- CI workflow is present and runs `npm ci`, `npm run verify`, and `npm pack --dry-run` on push/PR.
- `prepublishOnly` now runs the full verifier, not just the build.

## External Audit Notes

- Live OpenAPI mount audit: 2,529/2,529 OpenAPI specs reachable.
- Live remote MCP mount audit: 1,740/1,876 third-party remote MCP endpoints reachable or authentication/error-responsive; 136 third-party endpoints timed out or returned server errors.
- General homepage/repo/logo/doc-link audit found many failures in upstream catalog metadata and intentional examples/placeholders. These are not first-party runtime blockers, but the exact report should not be marketed as "all links work."
- ContentOps video is rendered and staged, but its deterministic QA result is `human_review` because the dark brand palette tripped the luma-variety heuristic. Human review is required before posting.

## Launch Sequence

1. Commit and push the release-prep changes.
2. Add GitHub topics: `mcp`, `model-context-protocol`, `mcp-server`, `aggregator`, `gateway`, `self-hosted`, `governance`, `local-first`, `claude`, `chatgpt`.
3. Publish npm only after approval: `npm publish --access public`.
4. Publish the official MCP registry entry from `server.json`.
5. Submit the `awesome-mcp-servers` PR using `marketing/registry-submissions.md`.
6. Post Show HN and stay in the comments for the first hour.
7. Post the technical Reddit variants to `r/LocalLLaMA` and `r/selfhosted`.
8. Post X/Threads/Bluesky thread and LinkedIn using the prepared copy.
9. After human review, approve the ContentOps video queue and distribute to X, LinkedIn, YouTube Shorts, TikTok, Instagram Reels, Threads, and Bluesky.
10. Submit directory blurbs to mcp.so, glama.ai, PulseMCP, and mcpservers.org.

## Positioning

Do not claim "number 1", "production-ready", "battle-tested", or fabricated traction. The strongest honest line is:

> MCP Switchboard is the self-hosted, local-first control plane for MCP tools: one governed endpoint for Claude, ChatGPT, Cursor, and your own agents, with BYO keys in a local encrypted vault, per-tool policy, approval gates, and an audit log.

That is stronger than hype because it is specific, verifiable, and sharply different from hosted tool routers.
