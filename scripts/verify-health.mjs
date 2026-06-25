// Deterministic oracle for the health/observability surface (src/dashboard.ts + src/gateway.ts).
// Pure data — NO network, NO Express, NO MCP transport. It imports the compiled, EXPORTED
// `buildHealthReport` (importing dist/dashboard.js is side-effect-free: startDashboard is declared,
// never invoked) and exercises it against synthetic inputs, then STATICALLY scans dist/dashboard.js
// and dist/gateway.js to prove the `/healthz` + `/api/health` routes and the dead-code-killing
// `serverHealth()` wiring actually ship.
//
// It proves:
//   buildHealthReport — folds declared servers + a live mount map + circuit-breaker health into ONE
//                       honest verdict: all-mounted+no-trip → ok; an ENABLED server that failed to
//                       mount → degraded (row mounted:false, tools:0); a DISABLED+unmounted server
//                       does NOT degrade; an OPEN circuit → degraded + circuits_open counted +
//                       retryAfterMs/consecutiveFailures surfaced; a HALF_OPEN probe is surfaced but
//                       does NOT degrade; circuit state is matched to the right server BY ID; a
//                       breaker entry for an UNKNOWN (non-configured) id is ignored (no fabricated
//                       row); empty config → ok with zeroed summary; the summary counts (total/
//                       mounted/enabled/circuits_open) agree with the rows.
//   route wiring      — a STATIC scan of dist/dashboard.js proves `/healthz` and `/api/health` are
//                       registered, that /healthz emits service+version+uptime, that /api/health
//                       calls buildHealthReport and returns 503 when degraded, that BOTH the dead
//                       serverHealth() is now called AND /api/state overlays the circuit, and that
//                       /healthz is registered BEFORE the SPA catch-all (so Express order lets the
//                       exact route win over the fallback). And dist/gateway.js EXPORTS VERSION.
// Zero deps (node stdlib + the package's compiled output). Build first.
import { readFileSync } from "node:fs";
import { buildHealthReport } from "../dist/dashboard.js";

const checks = [];
const assert = (name, cond, detail = "") => {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const circuit = (server, state, consecutiveFailures = 0, retryAfterMs = 0) => ({ server, state, consecutiveFailures, retryAfterMs });

// --- 1. all enabled + mounted, no circuit trips → ok ---------------------------------------------
{
  const configured = [
    { id: "alpha", source: "remote", enabled: true },
    { id: "beta", source: "npx", enabled: true },
  ];
  const mounted = new Map([["alpha", 5], ["beta", 2]]);
  const r = buildHealthReport(configured, mounted, []);
  assert("all mounted, no circuits → status ok", r.status === "ok", r.status);
  assert("summary total/mounted/enabled correct", eq(r.summary, { total: 2, mounted: 2, enabled: 2, circuits_open: 0 }), JSON.stringify(r.summary));
  assert("tool counts surfaced verbatim from the mount map", r.servers[0].tools === 5 && r.servers[1].tools === 2);
  assert("unobserved servers default to a closed circuit", r.servers.every((s) => s.circuit === "closed"));
  assert("no circuit entry → consecutiveFailures/retryAfterMs default to 0", r.servers.every((s) => s.consecutiveFailures === 0 && s.retryAfterMs === 0));
  assert("every row is marked mounted", r.servers.every((s) => s.mounted === true));
}

// --- 2. an ENABLED server that failed to mount → degraded ----------------------------------------
{
  const configured = [
    { id: "alpha", source: "remote", enabled: true },
    { id: "beta", source: "npx", enabled: true }, // enabled but NOT in the mount map
  ];
  const mounted = new Map([["alpha", 3]]);
  const r = buildHealthReport(configured, mounted, []);
  assert("enabled-but-unmounted → status degraded", r.status === "degraded", r.status);
  const beta = r.servers.find((s) => s.id === "beta");
  assert("the unmounted server's row is mounted:false, tools:0", beta.mounted === false && beta.tools === 0, JSON.stringify(beta));
  assert("summary.mounted counts only the live one", r.summary.mounted === 1, String(r.summary.mounted));
  assert("an unmounted enabled server does NOT inflate circuits_open", r.summary.circuits_open === 0);
}

// --- 3. a DISABLED (and therefore unmounted) server does NOT degrade -----------------------------
{
  const configured = [
    { id: "alpha", source: "remote", enabled: true },
    { id: "delta", source: "npx", enabled: false }, // disabled → legitimately unmounted
  ];
  const mounted = new Map([["alpha", 4]]);
  const r = buildHealthReport(configured, mounted, []);
  assert("disabled + unmounted → still ok (not a failure)", r.status === "ok", r.status);
  const delta = r.servers.find((s) => s.id === "delta");
  assert("disabled row reports enabled:false, mounted:false", delta.enabled === false && delta.mounted === false);
  assert("summary.enabled excludes the disabled server", r.summary.enabled === 1, String(r.summary.enabled));
  assert("summary.total still counts every declared server", r.summary.total === 2);
}

// --- 4. an OPEN circuit → degraded, counted, with retry/failure detail surfaced ------------------
{
  const configured = [
    { id: "alpha", source: "remote", enabled: true },
    { id: "beta", source: "npx", enabled: true },
  ];
  const mounted = new Map([["alpha", 1], ["beta", 1]]); // both mounted
  const r = buildHealthReport(configured, mounted, [circuit("beta", "open", 5, 30_000)]);
  assert("an open circuit on a mounted server → degraded", r.status === "degraded", r.status);
  assert("circuits_open counts the open breaker", r.summary.circuits_open === 1, String(r.summary.circuits_open));
  const beta = r.servers.find((s) => s.id === "beta");
  assert("open row carries circuit:open", beta.circuit === "open", beta.circuit);
  assert("consecutiveFailures surfaced from the breaker", beta.consecutiveFailures === 5, String(beta.consecutiveFailures));
  assert("retryAfterMs surfaced from the breaker", beta.retryAfterMs === 30_000, String(beta.retryAfterMs));
  assert("the healthy sibling stays closed/0", r.servers.find((s) => s.id === "alpha").circuit === "closed");
}

// --- 5. a HALF_OPEN probe is surfaced but does NOT degrade ---------------------------------------
{
  const configured = [{ id: "alpha", source: "remote", enabled: true }];
  const mounted = new Map([["alpha", 2]]);
  const r = buildHealthReport(configured, mounted, [circuit("alpha", "half_open", 2, 0)]);
  assert("half_open is NOT a degradation", r.status === "ok", r.status);
  assert("half_open does NOT count toward circuits_open", r.summary.circuits_open === 0);
  assert("half_open state is surfaced on the row", r.servers[0].circuit === "half_open", r.servers[0].circuit);
  assert("half_open still surfaces consecutiveFailures", r.servers[0].consecutiveFailures === 2);
}

// --- 6. circuit state is matched to the right server BY ID ---------------------------------------
{
  const configured = [
    { id: "alpha", source: "remote", enabled: true },
    { id: "beta", source: "npx", enabled: true },
    { id: "gamma", source: "app2mcp", enabled: true },
  ];
  const mounted = new Map([["alpha", 1], ["beta", 1], ["gamma", 1]]);
  const r = buildHealthReport(configured, mounted, [circuit("gamma", "open", 9, 12_000), circuit("alpha", "half_open", 1, 0)]);
  assert("circuit overlays land on the correct id (gamma open, alpha half_open, beta closed)",
    r.servers.find((s) => s.id === "gamma").circuit === "open" &&
    r.servers.find((s) => s.id === "alpha").circuit === "half_open" &&
    r.servers.find((s) => s.id === "beta").circuit === "closed");
  assert("only the open circuit degrades + counts (half_open does not)", r.status === "degraded" && r.summary.circuits_open === 1);
}

// --- 7. a breaker entry for an UNKNOWN id is ignored (no fabricated row) --------------------------
{
  const configured = [{ id: "alpha", source: "remote", enabled: true }];
  const mounted = new Map([["alpha", 1]]);
  // "ghost" is open but is NOT a configured server — it must neither appear as a row nor degrade.
  const r = buildHealthReport(configured, mounted, [circuit("ghost", "open", 7, 5000)]);
  assert("a stale/unknown breaker id produces NO server row", r.servers.length === 1 && r.servers[0].id === "alpha", String(r.servers.length));
  assert("an unknown open circuit does NOT degrade the report", r.status === "ok", r.status);
  assert("an unknown open circuit is NOT counted in circuits_open", r.summary.circuits_open === 0, String(r.summary.circuits_open));
}

// --- 8. empty config → ok with a zeroed summary --------------------------------------------------
{
  const r = buildHealthReport([], new Map(), []);
  assert("empty config → status ok", r.status === "ok", r.status);
  assert("empty config → no server rows", r.servers.length === 0);
  assert("empty config → zeroed summary", eq(r.summary, { total: 0, mounted: 0, enabled: 0, circuits_open: 0 }), JSON.stringify(r.summary));
}

// --- 9. summary counts are internally consistent with the rows (cross-check) ----------------------
{
  const configured = [
    { id: "a", source: "remote", enabled: true },
    { id: "b", source: "npx", enabled: true },
    { id: "c", source: "app2mcp", enabled: false },
    { id: "d", source: "remote", enabled: true },
  ];
  const mounted = new Map([["a", 2], ["b", 1]]); // c disabled-unmounted, d enabled-unmounted
  const r = buildHealthReport(configured, mounted, [circuit("a", "open", 3, 1000)]);
  assert("summary.total == row count", r.summary.total === r.servers.length);
  assert("summary.mounted == rows with mounted:true", r.summary.mounted === r.servers.filter((s) => s.mounted).length);
  assert("summary.enabled == rows with enabled:true", r.summary.enabled === r.servers.filter((s) => s.enabled).length);
  assert("summary.circuits_open == rows with circuit:open", r.summary.circuits_open === r.servers.filter((s) => s.circuit === "open").length);
  assert("degraded for BOTH reasons (open circuit AND an enabled-unmounted server)", r.status === "degraded");
}

// --- 10. route + export wiring (static scan of compiled output) -----------------------------------
{
  const src = readFileSync(new URL("../dist/dashboard.js", import.meta.url), "utf8");
  const gw = readFileSync(new URL("../dist/gateway.js", import.meta.url), "utf8");

  assert("dist/gateway.js EXPORTS VERSION", /export\s+const\s+VERSION\s*=/.test(gw));
  assert("dist/dashboard.js imports VERSION from gateway", /VERSION/.test(src) && /\.\/gateway\.js/.test(src));

  // /healthz liveness route is registered and emits the expected shape.
  assert("/healthz route is registered", /app\.get\(\s*["'`]\/healthz["'`]/.test(src));
  assert("/healthz emits service+version+uptime", /service:\s*["'`]switchboard["'`]/.test(src) && /version:\s*VERSION/.test(src) && /uptime/.test(src));

  // /api/health route is registered, calls buildHealthReport, and fails the HTTP status when degraded.
  assert("/api/health route is registered", /app\.get\(\s*["'`]\/api\/health["'`]/.test(src));
  assert("/api/health calls buildHealthReport", /buildHealthReport\(/.test(src));
  assert("/api/health returns 503 on a degraded verdict", /503/.test(src) && /status\s*===\s*["'`]ok["'`]\s*\?\s*200\s*:\s*503/.test(src));

  // The previously-dead Router.serverHealth() is now actually invoked (the Gap-12 wiring).
  assert("serverHealth() is now called from the dashboard", /serverHealth\(\)/.test(src));
  // /api/state overlays the circuit state (the operator-visible breaker badge).
  assert("/api/state overlays circuit state", /circuit:\s*circuits\.get\(/.test(src));

  // Express matches in registration order: /healthz MUST appear before the SPA catch-all regex,
  // otherwise the fallback handler would swallow it (it does not start with /api/).
  const healthzIdx = src.indexOf('app.get("/healthz"');
  const catchAllIdx = src.search(/app\.get\(\s*\/\^\(\?!/); // the `app.get(/^(?!.../ ` SPA fallback
  assert("/healthz is registered BEFORE the SPA catch-all", healthzIdx !== -1 && catchAllIdx !== -1 && healthzIdx < catchAllIdx, `healthz=${healthzIdx} catchAll=${catchAllIdx}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
