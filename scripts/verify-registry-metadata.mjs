// Deterministic oracle for launch/registry metadata. No network.
//
// It pins the official MCP Registry handoff:
//   - package.json carries the npm ownership marker (`mcpName`)
//   - server.json uses the current schema shape, matches package name/version, and runs stdio via `serve`
//   - the npm package includes server.json and both CLI bin aliases
//   - no placeholder/latest/range metadata slips into a release
import { readFileSync } from "node:fs";
const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const server = JSON.parse(readFileSync(new URL("server.json", root), "utf8"));
const checks = [];

function assert(name, cond, detail = "") {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const semverExact = (v) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(v));
const npmPackage = server.packages?.find((p) => p.registryType === "npm" && p.identifier === pkg.name);

assert("package.json has an mcpName ownership marker", typeof pkg.mcpName === "string" && pkg.mcpName.length > 0, String(pkg.mcpName ?? ""));
assert("server.json name equals package.json mcpName", server.name === pkg.mcpName, server.name === pkg.mcpName ? "" : `${server.name} != ${pkg.mcpName}`);
assert("server name uses the GitHub namespace", /^io\.github\.Mas-AI-Official\/mcp-switchboard$/.test(server.name), server.name);
assert("server.json uses the current registry schema", server.$schema === "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", server.$schema);
assert("server description is registry-sized (1..100 chars)", typeof server.description === "string" && server.description.length >= 1 && server.description.length <= 100, `${server.description?.length ?? 0} chars`);
assert("server version exactly matches package.json", server.version === pkg.version, server.version === pkg.version ? "" : `${server.version} != ${pkg.version}`);
assert("package version is exact semver, not a range/latest", semverExact(pkg.version) && pkg.version !== "latest", pkg.version);
assert("repository URL is the canonical HTTPS GitHub URL", server.repository?.url === "https://github.com/Mas-AI-Official/mcp-switchboard" && server.repository?.source === "github", JSON.stringify(server.repository));
assert("websiteUrl points at the README", server.websiteUrl === "https://github.com/Mas-AI-Official/mcp-switchboard#readme", String(server.websiteUrl ?? ""));
assert("server.json declares an npm package entry", !!npmPackage, JSON.stringify(server.packages ?? []));
assert("npm package entry version exactly matches package.json", npmPackage?.version === pkg.version, npmPackage?.version === pkg.version ? "" : `${npmPackage?.version} != ${pkg.version}`);
assert("npm package entry uses stdio transport", npmPackage?.transport?.type === "stdio", JSON.stringify(npmPackage?.transport ?? null));
assert("npm package entry launches the CLI with `serve`", Array.isArray(npmPackage?.packageArguments) && npmPackage.packageArguments.some((a) => a.type === "positional" && a.value === "serve"), JSON.stringify(npmPackage?.packageArguments ?? []));
assert("server.json does not ask the registry for secrets", !JSON.stringify(server).includes("environmentVariables"), "registry metadata should stay keyless");
assert("npm package publishes server.json", Array.isArray(pkg.files) && pkg.files.includes("server.json"), JSON.stringify(pkg.files ?? []));
assert("npm package exposes `switchboard` bin", pkg.bin?.switchboard === "dist/cli.js", JSON.stringify(pkg.bin ?? {}));
assert("npm package exposes `mcp-switchboard` bin alias", pkg.bin?.["mcp-switchboard"] === "dist/cli.js", JSON.stringify(pkg.bin ?? {}));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
