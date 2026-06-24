// Deterministic oracle for tool-shaping transforms (src/transforms.ts — Switchboard's answer to
// Composio "modifiers"). Exercises the four PURE functions in isolation against the compiled dist/,
// so there is no server, no network, no model — the oracle computes every verdict itself.
//
// It proves the contract the router relies on:
//   shapeExposedTool       — description override/trim; drop_params ∪ hide_params removed from BOTH
//                            properties and required; schema_mode required_only slimming; rename
//                            (upstream→exposed) in properties + required; server+tool modifiers merge.
//   applyArgTransforms     — renamed exposed keys reverse-map to upstream BEFORE injection; injected
//                            values (server then tool, tool wins) ALWAYS beat an agent-supplied value;
//                            ${vault:..}/${env:..} refs resolve through the resolver.
//   applyResponseRedaction — top-level field delete + replace_with; per-tool override beats server;
//                            non-JSON text / JSON arrays / primitives pass through untouched.
//   removedRequiredNotInjected — flags originally-required params dropped/hidden with no inject value.
//   INVARIANTS — never stamps additionalProperties:false; never mutates its inputs (purity).
// Zero deps (node stdlib + the package's own compiled output). Run `npm run build` first.
const {
  shapeExposedTool,
  applyArgTransforms,
  applyResponseRedaction,
  removedRequiredNotInjected,
} = await import("../dist/transforms.js");

const checks = [];
const assert = (name, cond, detail = "") => {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A representative upstream tool: two required params, one optional, a permissive schema.
const baseTool = () => ({
  name: "send_email",
  description: "Send an email message to one or more recipients via the upstream provider.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "recipient" },
      body: { type: "string", description: "message body" },
      from: { type: "string", description: "sender override" },
      cc: { type: "string", description: "carbon copy" },
    },
    required: ["to", "body"],
  },
});

const passResolver = (ref) => {
  // Mirror the real resolver's shape: a ${..} ref maps to a concrete value; a literal passes through.
  const map = { "${vault:sender}": "ops@switchboard.local", "${env:REGION}": "us-east-1" };
  return map[ref] ?? ref;
};

// --- 1. description override + trim --------------------------------------------------------------
{
  const t = shapeExposedTool(baseTool(), {}, { description_override: "Short override." });
  assert("description_override replaces the description", t.description === "Short override.");

  const trimmed = shapeExposedTool(baseTool(), { schema_modifiers: { trim_description: 10 } }, undefined);
  assert("trim_description truncates a long description to N chars", trimmed.description.length === 10, `len=${trimmed.description.length}`);

  // Override wins over trim when both apply.
  const both = shapeExposedTool(baseTool(), { schema_modifiers: { trim_description: 10 } }, { description_override: "Wins." });
  assert("description_override beats trim_description", both.description === "Wins.");
}

// --- 2. drop_params ∪ hide_params removed from properties AND required ----------------------------
{
  // drop via tool override, hide via server modifier — both must be gone, and pruned from required.
  const t = shapeExposedTool(
    baseTool(),
    { schema_modifiers: { hide_params: ["cc"] } },
    { drop_params: ["from"] },
  );
  const props = t.inputSchema.properties;
  assert("drop_params removes 'from' from properties", !("from" in props));
  assert("hide_params removes 'cc' from properties", !("cc" in props));
  assert("remaining properties are exactly to/body", deepEqual(Object.keys(props).sort(), ["body", "to"]));

  // Dropping a REQUIRED param also prunes it from required.
  const t2 = shapeExposedTool(baseTool(), {}, { drop_params: ["body"] });
  assert("dropping a required param prunes it from required", !t2.inputSchema.required.includes("body") && t2.inputSchema.required.includes("to"), JSON.stringify(t2.inputSchema.required));
}

// --- 3. schema_mode required_only slims to required props ----------------------------------------
{
  const t = shapeExposedTool(baseTool(), { schema_mode: "required_only" }, undefined);
  const keys = Object.keys(t.inputSchema.properties).sort();
  assert("required_only keeps only still-required props (to/body)", deepEqual(keys, ["body", "to"]), keys.join(","));
}

// --- 4. rename_params (upstream→exposed) in schema, reverse in args -------------------------------
{
  const serverCfg = { schema_modifiers: { rename_params: { to: "recipient" } } };
  const t = shapeExposedTool(baseTool(), serverCfg, undefined);
  assert("rename surfaces the EXPOSED name in properties", "recipient" in t.inputSchema.properties && !("to" in t.inputSchema.properties));
  assert("rename surfaces the EXPOSED name in required", t.inputSchema.required.includes("recipient") && !t.inputSchema.required.includes("to"), JSON.stringify(t.inputSchema.required));

  // The agent calls with the exposed key; applyArgTransforms reverse-maps it to the upstream key.
  const out = applyArgTransforms({ recipient: "a@b.com", body: "hi" }, serverCfg, undefined, passResolver);
  assert("applyArgTransforms reverse-maps exposed→upstream key", out.to === "a@b.com" && !("recipient" in out) && out.body === "hi", JSON.stringify(out));
}

// --- 5. inject_args overlay: server+tool merge, tool wins, refs resolve, injection beats agent ----
{
  const serverCfg = { inject_args: { from: "${vault:sender}", region: "${env:REGION}" } };
  const override = { inject_args: { region: "eu-west-1" } }; // tool overrides the server's region
  const out = applyArgTransforms(
    { to: "a@b.com", body: "hi", from: "attacker@evil.com" }, // agent tries to set `from`
    serverCfg,
    override,
    passResolver,
  );
  assert("inject resolves a ${vault:..} ref", out.from === "ops@switchboard.local", out.from);
  assert("injected value BEATS an agent-supplied value for the same key", out.from !== "attacker@evil.com");
  assert("tool inject_args overrides server inject_args (region=eu-west-1)", out.region === "eu-west-1", out.region);
  assert("agent's own untouched args pass through", out.to === "a@b.com" && out.body === "hi");
}

// --- 6. removedRequiredNotInjected flags orphaned required ----------------------------------------
{
  // Drop the required `body` with NO inject — orphaned (agent can't satisfy it upstream).
  const orphan = removedRequiredNotInjected(baseTool(), {}, { drop_params: ["body"] });
  assert("orphaned required param is flagged", orphan.includes("body") && orphan.length === 1, JSON.stringify(orphan));

  // Drop the required `to` but INJECT it — not orphaned (the value is supplied for the agent).
  const covered = removedRequiredNotInjected(baseTool(), { inject_args: { to: "${vault:sender}" } }, { drop_params: ["to"] });
  assert("a dropped-but-injected required param is NOT flagged", covered.length === 0, JSON.stringify(covered));

  // Dropping an OPTIONAL param is never orphaned (it was never required).
  const optional = removedRequiredNotInjected(baseTool(), {}, { drop_params: ["cc"] });
  assert("dropping an optional param is not flagged", optional.length === 0, JSON.stringify(optional));
}

// --- 7. NEVER stamp additionalProperties:false ---------------------------------------------------
{
  const t = shapeExposedTool(baseTool(), { schema_mode: "required_only" }, { drop_params: ["from"], schema_modifiers: { hide_params: ["cc"], rename_params: { to: "recipient" } } });
  assert("shaped schema never gains additionalProperties:false", t.inputSchema.additionalProperties === undefined, String(t.inputSchema.additionalProperties));
}

// --- 8. applyResponseRedaction: delete, replace_with, per-tool override, passthroughs --------------
{
  const jsonResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

  // delete (no replace_with) strips the field entirely.
  const del = applyResponseRedaction(jsonResult({ id: 1, secret: "x", name: "n" }), { redact_response: { fields: ["secret"] } }, undefined);
  assert("redaction DELETES a field when no replace_with", !("secret" in JSON.parse(del.content[0].text)) && JSON.parse(del.content[0].text).id === 1);

  // replace_with substitutes a constant.
  const rep = applyResponseRedaction(jsonResult({ token: "abc" }), { redact_response: { fields: ["token"], replace_with: "[hidden]" } }, undefined);
  assert("redaction REPLACES a field with replace_with", JSON.parse(rep.content[0].text).token === "[hidden]");

  // per-tool override beats the server-level redaction.
  const ovr = applyResponseRedaction(
    jsonResult({ a: 1, b: 2 }),
    { redact_response: { fields: ["a"] } },
    { redact_response: { fields: ["b"] } },
  );
  const parsed = JSON.parse(ovr.content[0].text);
  assert("per-tool redact_response overrides server-level", "a" in parsed && !("b" in parsed), JSON.stringify(parsed));

  // non-JSON text passes through untouched.
  const plain = { content: [{ type: "text", text: "secret: not json" }] };
  const plainOut = applyResponseRedaction(plain, { redact_response: { fields: ["secret"] } }, undefined);
  assert("non-JSON text content is left untouched", plainOut.content[0].text === "secret: not json");

  // a JSON ARRAY (not an object) passes through untouched.
  const arr = { content: [{ type: "text", text: JSON.stringify([{ secret: "x" }]) }] };
  const arrOut = applyResponseRedaction(arr, { redact_response: { fields: ["secret"] } }, undefined);
  assert("a top-level JSON array is left untouched", arrOut.content[0].text === JSON.stringify([{ secret: "x" }]));

  // no redaction configured → identity.
  const id = jsonResult({ a: 1 });
  const idOut = applyResponseRedaction(id, {}, undefined);
  assert("no redaction config is an identity transform", idOut.content[0].text === id.content[0].text);
}

// --- 9. PURITY: inputs are never mutated ---------------------------------------------------------
{
  const tool = baseTool();
  const toolSnapshot = JSON.stringify(tool);
  shapeExposedTool(tool, { schema_mode: "required_only" }, { drop_params: ["from"], schema_modifiers: { rename_params: { to: "recipient" } } });
  assert("shapeExposedTool does not mutate the upstream tool", JSON.stringify(tool) === toolSnapshot);

  const args = { recipient: "a@b.com", from: "x" };
  const argsSnapshot = JSON.stringify(args);
  applyArgTransforms(args, { schema_modifiers: { rename_params: { to: "recipient" } }, inject_args: { from: "${vault:sender}" } }, undefined, passResolver);
  assert("applyArgTransforms does not mutate the input args", JSON.stringify(args) === argsSnapshot);

  const result = { content: [{ type: "text", text: JSON.stringify({ secret: "x", id: 1 }) }] };
  const resultSnapshot = JSON.stringify(result);
  applyResponseRedaction(result, { redact_response: { fields: ["secret"] } }, undefined);
  assert("applyResponseRedaction does not mutate the input result", JSON.stringify(result) === resultSnapshot);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
