/**
 * Outbound webhook delivery for policy decisions.
 *
 * When `settings.webhook` is enabled, every governed tool-call verdict whose decision is in
 * the configured `events` list is POSTed to the operator's URL as a slim JSON event. Delivery
 * is FIRE-AND-FORGET and FAIL-OPEN by construction: a webhook that is slow, down, or
 * misconfigured must never block, delay, or alter a governance decision — the decision is
 * already made and audited before we notify.
 *
 * The payload carries decision metadata only (server, tool, scope, decision, reason, timing) —
 * never the call's arguments or the upstream response. So enabling a webhook can never quietly
 * become an I/O exfiltration channel, even when `settings.logs.capture_io` is on.
 *
 * When `secret_ref` resolves to a vault secret, each delivery is signed with an
 * `x-switchboard-signature: sha256=<hmac>` header (the same scheme as the Settings page's
 * "send test event" button) so the receiver can authenticate it. If a `secret_ref` is
 * configured but cannot be resolved we DROP the delivery rather than send an unsigned event a
 * receiver would (rightly) reject — fail-closed on authenticity, still fail-open on the
 * governance decision itself.
 */

import { createHmac } from "node:crypto";
import type { SwitchboardConfig } from "./types.js";
import { log } from "./logger.js";

/** Resolves a `${vault:...}` / `${env:...}` reference to its secret (Vault.resolve). */
export type SecretResolver = (ref: string) => string;

/** A policy-decision event delivered to the webhook. Decision metadata only — no call I/O. */
export interface WebhookEvent {
  decision: "allow" | "deny" | "approval_required";
  server: string;
  tool: string;
  scope: string;
  reason?: string;
  duration_ms?: number;
  error?: string;
}

const TIMEOUT_MS = 8000;

/**
 * Notify the configured webhook of one decision. Returns immediately; the POST runs detached.
 * Any failure is swallowed (logged at warn) so it can never affect the caller.
 */
export function deliverWebhook(cfg: SwitchboardConfig, event: WebhookEvent, resolveSecret: SecretResolver): void {
  const wh = cfg.settings?.webhook;
  if (!wh?.enabled || !wh.url) return;

  // Per the config contract: an empty/omitted `events` list means "deliver every decision".
  // The shipped example pins it to [deny, approval_required] so this fallback only fires if
  // the operator deliberately clears the list.
  if (wh.events && wh.events.length > 0 && !wh.events.includes(event.decision)) return;

  const payload = JSON.stringify({
    type: "switchboard.decision",
    ts: new Date().toISOString(),
    decision: event.decision,
    server: event.server,
    tool: event.tool,
    scope: event.scope,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(typeof event.duration_ms === "number" ? { duration_ms: event.duration_ms } : {}),
    ...(event.error ? { error: event.error } : {}),
  });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (wh.secret_ref) {
    try {
      const secret = resolveSecret(wh.secret_ref);
      headers["x-switchboard-signature"] = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    } catch {
      // A signature was promised but the secret is unavailable: drop rather than send an
      // unsigned event the receiver will reject. Never throws into the caller.
      log.warn(`webhook: cannot resolve secret '${wh.secret_ref}', dropping ${event.decision} notification`);
      return;
    }
  }

  const url = wh.url;
  // Detached delivery. The governance decision is already settled + audited; this is best effort.
  void (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      await fetch(url, { method: "POST", headers, body: payload, signal: ctrl.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`webhook: delivery to ${url} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  })();
}
