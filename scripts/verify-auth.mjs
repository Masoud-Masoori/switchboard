// Deterministic oracle for auth_scheme translation (src/authscheme.ts — the declarative shorthand
// → HTTP headers / stdio env vars). Exercises the two PURE functions against the compiled dist/ with
// an injected resolver, so there is no vault, no registry, no network — the oracle computes every
// verdict itself.
//
// It proves:
//   authSchemeHeaders — bearer→`Authorization: Bearer`; api_key→named header (default X-Api-Key);
//                       api_key query-only→SKIPPED (no header form); basic→`Authorization: Basic
//                       <base64(user:pass)>`; header→named custom header. Every *_ref goes through
//                       the resolver (fail-closed if it throws).
//   authSchemeEnv     — bearer→BEARER_TOKEN; api_key→UPPER_SNAKE(header) or API_KEY; basic→
//                       BASIC_AUTH_USERNAME+BASIC_AUTH_PASSWORD; header→UPPER_SNAKE(name).
// Zero deps (node stdlib + the package's own compiled output). Run `npm run build` first.
import { authSchemeHeaders, authSchemeEnv } from "../dist/authscheme.js";

const checks = [];
const assert = (name, cond, detail = "") => {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A resolver that maps refs to concrete secrets; a literal passes through; an unknown ref throws.
const resolve = async (ref) => {
  const map = {
    "${vault:token}": "TKN-123",
    "${vault:key}": "KEY-abc",
    "${vault:user}": "alice",
    "${vault:pass}": "s3cr3t",
    "${oauth:gmail}": "ya29.OAUTH",
  };
  if (ref in map) return map[ref];
  if (ref.startsWith("${")) throw new Error(`unresolved ref ${ref}`);
  return ref; // a literal value
};

// --- bearer --------------------------------------------------------------------------------------
{
  const h = await authSchemeHeaders({ kind: "bearer", ref: "${vault:token}" }, resolve);
  assert("bearer → Authorization: Bearer <token>", h.Authorization === "Bearer TKN-123", JSON.stringify(h));
  const e = await authSchemeEnv({ kind: "bearer", ref: "${oauth:gmail}" }, resolve);
  assert("bearer env → BEARER_TOKEN, resolves ${oauth:}", e.BEARER_TOKEN === "ya29.OAUTH", JSON.stringify(e));
}

// --- api_key -------------------------------------------------------------------------------------
{
  // default header name when none specified
  const def = await authSchemeHeaders({ kind: "api_key", ref: "${vault:key}" }, resolve);
  assert("api_key default header is X-Api-Key", def["X-Api-Key"] === "KEY-abc", JSON.stringify(def));

  // explicit header name wins
  const named = await authSchemeHeaders({ kind: "api_key", ref: "${vault:key}", header: "X-Custom-Key" }, resolve);
  assert("api_key honors an explicit header name", named["X-Custom-Key"] === "KEY-abc" && !("X-Api-Key" in named), JSON.stringify(named));

  // query-only key has NO header form → skipped
  const queryOnly = await authSchemeHeaders({ kind: "api_key", ref: "${vault:key}", query: "api_key" }, resolve);
  assert("api_key query-only is skipped in headers", deepEqual(queryOnly, {}), JSON.stringify(queryOnly));

  // query + header named → still injected as a header
  const both = await authSchemeHeaders({ kind: "api_key", ref: "${vault:key}", query: "api_key", header: "X-Key" }, resolve);
  assert("api_key with both query+header still sets the header", both["X-Key"] === "KEY-abc", JSON.stringify(both));

  // env: default API_KEY, or UPPER_SNAKE of the header name
  const eDef = await authSchemeEnv({ kind: "api_key", ref: "${vault:key}" }, resolve);
  assert("api_key env default is API_KEY", eDef.API_KEY === "KEY-abc", JSON.stringify(eDef));
  const eNamed = await authSchemeEnv({ kind: "api_key", ref: "${vault:key}", header: "X-Custom-Key" }, resolve);
  assert("api_key env upper-snakes the header name", eNamed.X_CUSTOM_KEY === "KEY-abc", JSON.stringify(eNamed));
}

// --- basic ---------------------------------------------------------------------------------------
{
  const h = await authSchemeHeaders({ kind: "basic", username_ref: "${vault:user}", password_ref: "${vault:pass}" }, resolve);
  const expected = `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`;
  assert("basic → Authorization: Basic <base64(user:pass)>", h.Authorization === expected, JSON.stringify(h));

  const e = await authSchemeEnv({ kind: "basic", username_ref: "${vault:user}", password_ref: "${vault:pass}" }, resolve);
  assert("basic env → BASIC_AUTH_USERNAME + BASIC_AUTH_PASSWORD", e.BASIC_AUTH_USERNAME === "alice" && e.BASIC_AUTH_PASSWORD === "s3cr3t", JSON.stringify(e));
}

// --- header (custom) -----------------------------------------------------------------------------
{
  const h = await authSchemeHeaders({ kind: "header", name: "X-Org-Token", ref: "${vault:token}" }, resolve);
  assert("header → named custom header", h["X-Org-Token"] === "TKN-123", JSON.stringify(h));
  const e = await authSchemeEnv({ kind: "header", name: "X-Org-Token", ref: "${vault:token}" }, resolve);
  assert("header env upper-snakes the name → X_ORG_TOKEN", e.X_ORG_TOKEN === "TKN-123", JSON.stringify(e));
}

// --- fail-closed: an unresolved ref propagates (never silently sends an unauthed header) ----------
{
  let threw = false;
  try {
    await authSchemeHeaders({ kind: "bearer", ref: "${vault:missing}" }, resolve);
  } catch {
    threw = true;
  }
  assert("an unresolvable ref throws (fail closed)", threw);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
