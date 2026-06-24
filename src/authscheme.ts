/**
 * auth_scheme translation — the declarative `auth_scheme` shorthand → concrete HTTP headers (for
 * remote / app2mcp / http-tool sources) or child-process env vars (for stdio sources).
 *
 * Pure given a `resolve` function: every `*_ref` is handed to the caller's resolver (which swaps
 * `${oauth:..}` / `${vault:..}` / `${env:..}` for a live secret, fail-closed). Keeping this pure and
 * resolver-injected makes it unit-testable without a vault, a registry, or the network — and keeps
 * the single source of truth for "how an auth_scheme becomes a credential" in one place.
 *
 * Header vs env are deliberately NOT symmetric:
 *   - HTTP transports want real header names (`Authorization`, `X-Api-Key`, or a custom one).
 *   - stdio children want conventional UPPER_SNAKE env vars the common MCP servers already read.
 * An `api_key` delivered ONLY via a query string (no `header`) has no header form and is skipped by
 * {@link authSchemeHeaders}; set it as a `credentials`/`env` entry if a header is not wanted.
 */

import type { AuthScheme } from "./types.js";

/** Async secret resolver — `${oauth:..}`/`${vault:..}`/`${env:..}` → a concrete value (fail-closed). */
export type RefResolver = (ref: string) => Promise<string>;

/** UPPER_SNAKE a header/param name for use as an environment variable: `X-Api-Key` → `X_API_KEY`. */
function toEnvName(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

/**
 * Render an `auth_scheme` into HTTP request header(s). `bearer` → `Authorization: Bearer <token>`;
 * `api_key` → the named header (default `X-Api-Key`), skipped when the key is query-only; `basic` →
 * `Authorization: Basic <base64(user:pass)>`; `header` → the named custom header.
 */
export async function authSchemeHeaders(scheme: AuthScheme, resolve: RefResolver): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  switch (scheme.kind) {
    case "bearer":
      headers["Authorization"] = `Bearer ${await resolve(scheme.ref)}`;
      break;
    case "api_key":
      // Inject as a header when a header is named, or by default; skip a query-only key (no header form).
      if (scheme.header || !scheme.query) {
        headers[scheme.header ?? "X-Api-Key"] = await resolve(scheme.ref);
      }
      break;
    case "basic": {
      const user = await resolve(scheme.username_ref);
      const pass = await resolve(scheme.password_ref);
      headers["Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      break;
    }
    case "header":
      headers[scheme.name] = await resolve(scheme.ref);
      break;
  }
  return headers;
}

/**
 * Render an `auth_scheme` into child-process env var(s) using conventional names:
 * `bearer` → `BEARER_TOKEN`; `api_key` → the upper-snaked header name or `API_KEY`; `basic` →
 * `BASIC_AUTH_USERNAME` + `BASIC_AUTH_PASSWORD`; `header` → the upper-snaked header name. If an
 * upstream server expects different variables, set `env:` directly — that path is unchanged.
 */
export async function authSchemeEnv(scheme: AuthScheme, resolve: RefResolver): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  switch (scheme.kind) {
    case "bearer":
      env["BEARER_TOKEN"] = await resolve(scheme.ref);
      break;
    case "api_key":
      env[scheme.header ? toEnvName(scheme.header) : "API_KEY"] = await resolve(scheme.ref);
      break;
    case "basic":
      env["BASIC_AUTH_USERNAME"] = await resolve(scheme.username_ref);
      env["BASIC_AUTH_PASSWORD"] = await resolve(scheme.password_ref);
      break;
    case "header":
      env[toEnvName(scheme.name)] = await resolve(scheme.ref);
      break;
  }
  return env;
}
