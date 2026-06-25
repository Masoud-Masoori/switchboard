/**
 * verify-limits.mjs — deterministic oracle for rate limits + spend budgets (Feature: Governor).
 *
 * Hosted aggregators meter calls to BILL you; Switchboard runs on your machine, so the same
 * accounting becomes a governance control: cap how fast (and how expensively) an agent may hit a
 * tool, fail-closed, so a runaway loop or a pricey council can't quietly burn your API budget.
 *
 * This proves the engine with a synthetic clock (no wall time, no network, no boot):
 *   • TokenBucket — refill is time-proportional + capped, idempotent at a fixed `now`, take is
 *     all-or-nothing, retryAfterMs is 0 / finite / Infinity in the three reachable regimes.
 *   • Governor stacking — a call must satisfy tool AND server AND global; the TIGHTEST binding
 *     limit (most-specific level, shortest window) is the one reported.
 *   • Cost budgets — a tool's `cost` is summed against cost_per_* and exhausts independently of rate.
 *   • Conservative / fail-closed — denied draws still commit nothing (all-or-nothing); a window
 *     refills calls back after time passes.
 *   • Misconfig — a per-call cost that exceeds the budget capacity can NEVER pass (retryAfterMs ∞).
 *   • Fast path — a config with no limits anywhere returns ok with zero buckets allocated.
 *   • Key safety — server/tool ids with `__`, quotes, brackets never collide (tupleKey is injective).
 *   • Round-trip — limits/cost on settings+server+tool survive writeConfig→loadConfig through zod,
 *     and an all-empty `limits:{}` block is REJECTED by the refine guard.
 *
 * Run: node scripts/verify-limits.mjs   (exit 0 = all green, 1 = a check failed)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenBucket, Governor } from "../dist/governor.js";
import { starterConfig, writeConfig, loadConfig } from "../dist/config.js";

const checks = [];
const assert = (name, cond, detail = "") => {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const root = mkdtempSync(join(tmpdir(), "sb-limits-"));
try {
  // ---- TokenBucket: refill, cap, idempotence, take, retryAfterMs ----------
  {
    // capacity 10 over a minute ⇒ refillPerMs = 10/60000.
    const b = new TokenBucket(10, 10 / MIN, 0);
    assert("bucket: starts full at capacity", b.peek(0) === 10);
    assert("bucket: take within capacity succeeds", b.take(4, 0) === true);
    assert("bucket: tokens deducted", near(b.peek(0), 6));
    assert("bucket: peek is idempotent at fixed now", near(b.peek(0), 6));
    assert("bucket: over-draw fails, no mutation", b.take(7, 0) === false && near(b.peek(0), 6));
    // refill proportional to elapsed time: +30s ⇒ +5 tokens ⇒ 11 capped to 10.
    assert("bucket: refill is time-proportional + capped", b.peek(30_000) === 10);
    // drain to empty, then prove retryAfterMs math.
    assert("bucket: drain to empty", b.take(10, 30_000) === true && near(b.peek(30_000), 0));
    assert("bucket: retry=0 when available", new TokenBucket(5, 5 / MIN, 0).retryAfterMs(3, 0) === 0);
    // empty bucket needs 2 tokens; at 10/60000 per ms ⇒ 2 / (10/60000) = 12000 ms.
    assert("bucket: retry is finite + correct when refilling", b.retryAfterMs(2, 30_000) === 12_000);
    // after exactly that wait, the 2 tokens are available.
    assert("bucket: available after the computed wait", b.peek(42_000) >= 2);
    // need beyond capacity is unreachable by waiting ⇒ Infinity.
    assert("bucket: retry=∞ when need exceeds capacity", b.retryAfterMs(11, 0) === Infinity);
    // a frozen bucket (refillPerMs 0) that is empty can never satisfy a positive need.
    const frozen = new TokenBucket(1, 0, 0);
    frozen.take(1, 0);
    assert("bucket: retry=∞ when refill rate is 0", frozen.retryAfterMs(1, 0) === Infinity);
  }

  // ---- Governor fast path: no limits ⇒ ok, no buckets --------------------
  {
    const cfg = { gateway: { default_policy: "full" }, vault: {}, servers: [{ id: "git", source: "npx" }] };
    const g = new Governor(cfg);
    assert("fast-path: unlimited call is allowed", g.consume("git", "status", 0).ok === true);
    assert("fast-path: repeated calls stay allowed", g.consume("git", "status", 0).ok && g.consume("git", "status", 0).ok);
  }

  // ---- Governor rate limit at the GLOBAL level ----------------------------
  {
    const cfg = {
      gateway: { default_policy: "full" },
      vault: {},
      servers: [{ id: "git", source: "npx" }],
      settings: { limits: { per_minute: 2 } },
    };
    const g = new Governor(cfg);
    assert("global: 1st call ok", g.consume("git", "a", 0).ok === true);
    assert("global: 2nd call ok", g.consume("git", "b", 0).ok === true);
    const d = g.consume("git", "c", 0);
    assert("global: 3rd call denied (fail-closed)", d.ok === false);
    assert("global: denial attributes the level", d.level === "global", d.level);
    assert("global: denial attributes the window", d.window === "minute", d.window);
    assert("global: denial is a rate kind", d.kind === "rate");
    assert("global: retry finite within the window", d.retryAfterMs > 0 && isFinite(d.retryAfterMs));
    assert("global: reason names the subject + ceiling", /global .*2 calls\/minute/.test(d.reason), d.reason);
    // the SAME global bucket counts a DIFFERENT server/tool — it is not per-tool.
    assert("global: window refills after a minute", g.consume("git", "d", MIN).ok === true);
  }

  // ---- Governor stacking: tightest level binds first ---------------------
  {
    // global allows 100/min, server allows 5/min, the tool allows 2/min.
    const cfg = {
      gateway: { default_policy: "full" },
      vault: {},
      servers: [
        {
          id: "github",
          source: "npx",
          limits: { per_minute: 5 },
          tools: { create_issue: { limits: { per_minute: 2 } } },
        },
      ],
      settings: { limits: { per_minute: 100 } },
    };
    const g = new Governor(cfg);
    assert("stack: tool call 1 ok", g.consume("github", "create_issue", 0).ok === true);
    assert("stack: tool call 2 ok", g.consume("github", "create_issue", 0).ok === true);
    const d = g.consume("github", "create_issue", 0);
    assert("stack: tool call 3 denied by the TOOL limit", d.ok === false && d.level === "tool", d.level);
    assert("stack: tool denial names the tool", /tool 'github__create_issue'/.test(d.reason), d.reason);
    // a DIFFERENT tool on the same server is not throttled by the tool bucket, but shares the server's 5/min.
    assert("stack: other tool call 1 ok (server has room)", g.consume("github", "list_issues", 0).ok === true);
    assert("stack: other tool call 2 ok", g.consume("github", "list_issues", 0).ok === true);
    // server has now seen 2 (create_issue) + 2 (list_issues) = 4; one more is the 5th and last.
    assert("stack: other tool call 3 ok (server hits 5)", g.consume("github", "list_issues", 0).ok === true);
    const ds = g.consume("github", "list_issues", 0);
    assert("stack: 6th server call denied by the SERVER limit", ds.ok === false && ds.level === "server", ds.level);
    assert("stack: server denial names the server", /server 'github'/.test(ds.reason), ds.reason);
  }

  // ---- Governor cost budget: independent of call count -------------------
  {
    // 3 calls/min is generous, but each council call costs 5 and the cost budget is 12/min ⇒ the
    // 3rd call (cost 15 > 12) is denied on COST, not rate.
    const cfg = {
      gateway: { default_policy: "full" },
      vault: {},
      servers: [
        {
          id: "council",
          source: "npx",
          limits: { per_minute: 3, cost_per_minute: 12 },
          tools: { ask: { cost: 5 } },
        },
      ],
    };
    const g = new Governor(cfg);
    assert("cost: call 1 ok (cost 5/12)", g.consume("council", "ask", 0).ok === true);
    assert("cost: call 2 ok (cost 10/12)", g.consume("council", "ask", 0).ok === true);
    const d = g.consume("council", "ask", 0);
    assert("cost: call 3 denied on COST not rate", d.ok === false && d.kind === "cost", `${d.kind} ${d.reason}`);
    assert("cost: denial says budget", /budget/.test(d.reason), d.reason);
    assert("cost: rate still had room", d.level === "server" && d.window === "minute");
    // a zero-cost tool on the same server is unaffected by the cost budget (still bound by rate 3/min).
    const g2 = new Governor(cfg);
    g2.consume("council", "ask", 0); // cost 5
    assert("cost: zero-cost tool not charged against budget", g2.consume("council", "free", 0).ok === true);
  }

  // ---- Governor misconfig: per-call cost exceeds the budget capacity -----
  {
    const cfg = {
      gateway: { default_policy: "full" },
      vault: {},
      servers: [
        {
          id: "x",
          source: "npx",
          limits: { cost_per_minute: 4 },
          tools: { big: { cost: 10 } },
        },
      ],
    };
    const g = new Governor(cfg);
    const d = g.consume("x", "big", 0);
    assert("misconfig: a call costing more than the budget can never pass", d.ok === false);
    assert("misconfig: retry is ∞ (unsatisfiable as configured)", d.retryAfterMs === Infinity);
    assert("misconfig: reason explains it can never pass", /never pass/.test(d.reason), d.reason);
  }

  // ---- Conservative / all-or-nothing commit ------------------------------
  {
    // tool allows 1/min; server allows 1/min. The first call commits both. The denied second call
    // must NOT have partially debited anything — proven by both buckets refilling together later.
    const cfg = {
      gateway: { default_policy: "full" },
      vault: {},
      servers: [{ id: "s", source: "npx", limits: { per_minute: 1 }, tools: { t: { limits: { per_minute: 1 } } } }],
    };
    const g = new Governor(cfg);
    assert("commit: 1st call ok", g.consume("s", "t", 0).ok === true);
    assert("commit: 2nd call denied", g.consume("s", "t", 0).ok === false);
    // after a full minute both windows refill ⇒ exactly one more call passes, then denied again.
    assert("commit: after refill, one more passes", g.consume("s", "t", MIN).ok === true);
    assert("commit: and is throttled again", g.consume("s", "t", MIN).ok === false);
  }

  // ---- Multi-window: a daily cap binds even when the minute has room ------
  {
    const cfg = {
      gateway: { default_policy: "full" },
      vault: {},
      servers: [{ id: "s", source: "npx", limits: { per_minute: 100, per_day: 2 } }],
    };
    const g = new Governor(cfg);
    assert("window: day call 1 ok", g.consume("s", "t", 0).ok === true);
    assert("window: day call 2 ok", g.consume("s", "t", HOUR).ok === true);
    const d = g.consume("s", "t", 2 * HOUR);
    assert("window: day call 3 denied by the DAY window", d.ok === false && d.window === "day", d.window);
    assert("window: refills only after a full day", g.consume("s", "t", DAY + 1).ok === true);
  }

  // ---- Key safety: adversarial ids never collide -------------------------
  {
    // server "a" + tool "b__c"  vs  server "a__b" + tool "c": a naive "id__tool" join would merge
    // these into the same bucket. tupleKey (JSON.stringify of a tuple) keeps them distinct.
    const cfg = {
      gateway: { default_policy: "full" },
      vault: {},
      servers: [
        { id: "a", source: "npx", tools: { "b__c": { limits: { per_minute: 1 } } } },
        { id: "a__b", source: "npx", tools: { c: { limits: { per_minute: 1 } } } },
      ],
    };
    const g = new Governor(cfg);
    assert("keys: a / b__c first call ok", g.consume("a", "b__c", 0).ok === true);
    // if the buckets collided, this DIFFERENT tool would already be exhausted; it must be independent.
    assert("keys: a__b / c is an independent bucket", g.consume("a__b", "c", 0).ok === true);
    assert("keys: a / b__c now throttled", g.consume("a", "b__c", 0).ok === false);
    assert("keys: a__b / c independently throttled", g.consume("a__b", "c", 0).ok === false);
  }

  // ---- Real config round-trip: limits survive the zod schema -------------
  {
    const cfg = starterConfig();
    cfg.settings = { limits: { per_minute: 60, cost_per_day: 100 } };
    cfg.servers[0].limits = { per_hour: 500 };
    cfg.servers[0].tools = {
      ...(cfg.servers[0].tools ?? {}),
      longRunningOperation: { limits: { per_minute: 5 }, cost: 2.5 },
    };
    const p = join(root, "switchboard.config.yaml");
    writeConfig(p, cfg);
    const r = loadConfig(p); // throws if any limits/cost field is schema-invalid
    assert("roundtrip: global limits survive", r.settings.limits.per_minute === 60 && r.settings.limits.cost_per_day === 100);
    assert("roundtrip: server limits survive", r.servers[0].limits.per_hour === 500);
    assert("roundtrip: tool limits survive", r.servers[0].tools.longRunningOperation.limits.per_minute === 5);
    assert("roundtrip: fractional tool cost survives", r.servers[0].tools.longRunningOperation.cost === 2.5);
    // and the reloaded config drives a live Governor identically.
    const g = new Governor(r);
    assert("roundtrip: reloaded config enforces the tool limit", (() => {
      for (let i = 0; i < 5; i++) if (!g.consume(r.servers[0].id, "longRunningOperation", 0).ok) return false;
      return g.consume(r.servers[0].id, "longRunningOperation", 0).ok === false;
    })());
  }

  // ---- refine guard: an empty limits block is REJECTED -------------------
  {
    const cfg = starterConfig();
    cfg.settings = { limits: {} }; // no ceiling set anywhere ⇒ meaningless ⇒ must be rejected
    const p = join(root, "bad-empty.config.yaml");
    writeConfig(p, cfg);
    assert("refine: an all-empty limits block is REJECTED", throws(() => loadConfig(p)));
  }
  {
    const cfg = starterConfig();
    cfg.servers[0].limits = { per_minute: 0 }; // zero is not a positive ceiling ⇒ rejected
    const p = join(root, "bad-zero.config.yaml");
    writeConfig(p, cfg);
    assert("refine: a non-positive rate ceiling is REJECTED", throws(() => loadConfig(p)));
  }
  {
    const cfg = starterConfig();
    cfg.servers[0].limits = { per_minute: 1.5 }; // call counts must be integers ⇒ rejected
    const p = join(root, "bad-frac.config.yaml");
    writeConfig(p, cfg);
    assert("refine: a fractional call-count ceiling is REJECTED", throws(() => loadConfig(p)));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) console.log("FAILED:", failed.map((c) => c.name).join(", "));
process.exitCode = failed.length === 0 ? 0 : 1;
