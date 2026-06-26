/**
 * verify-local-llm.mjs — deterministic oracle for `switchboard local-llm`.
 *
 * Proves the PURE pieces of src/localllm.ts without a network or a running model:
 *   • parseOpenAiModels / parseOllamaTags — tolerant extraction from real + junk bodies
 *   • pickDefaultModel — preference order + case-insensitivity + fallbacks
 *   • buildLocalProvider — exact council provider shape (keyless)
 *   • withLocalProvider — idempotent merge, council creation, opt-out respect, no mutation
 *   • installGuide — per-OS copy-paste steps (printed, never executed)
 *   • a real config round-trip proving the wired block survives the zod schema (loadConfig)
 *
 * Run: node scripts/verify-local-llm.mjs   (exit 0 = all green, 1 = a check failed)
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_RUNTIMES,
  parseOpenAiModels,
  parseOllamaTags,
  pickDefaultModel,
  classifyModel,
  buildLocalProvider,
  withLocalProvider,
  wireAdvice,
  installGuide,
} from "../dist/localllm.js";
import { starterConfig, writeConfig, loadConfig } from "../dist/config.js";

const checks = [];
const assert = (name, cond, detail = "") => {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// minimal SwitchboardConfig-shaped object; withLocalProvider only ever touches settings.council
const baseCfg = (settings) => ({ gateway: {}, vault: {}, servers: [], ...(settings ? { settings } : {}) });

const root = mkdtempSync(join(tmpdir(), "sb-localllm-"));
try {
  // ---- KNOWN_RUNTIMES ----------------------------------------------------
  assert("4 known runtimes", KNOWN_RUNTIMES.length === 4, KNOWN_RUNTIMES.map((r) => r.id).join(","));
  for (const id of ["ollama", "lmstudio", "llamacpp", "vllm"]) {
    assert(`runtime '${id}' present`, KNOWN_RUNTIMES.some((r) => r.id === id));
  }
  for (const r of KNOWN_RUNTIMES) {
    assert(`${r.id} baseUrl ends /v1`, r.baseUrl.endsWith("/v1"), r.baseUrl);
    assert(`${r.id} modelsUrl = baseUrl + /models`, r.modelsUrl === `${r.baseUrl}/models`, r.modelsUrl);
    assert(`${r.id} binds loopback`, r.baseUrl.includes("127.0.0.1"), r.baseUrl);
  }
  assert("ollama on :11434", KNOWN_RUNTIMES.find((r) => r.id === "ollama")?.baseUrl === "http://127.0.0.1:11434/v1");
  assert("lmstudio on :1234", KNOWN_RUNTIMES.find((r) => r.id === "lmstudio")?.baseUrl === "http://127.0.0.1:1234/v1");

  // ---- parseOpenAiModels -------------------------------------------------
  assert("openai: extracts ids", eq(parseOpenAiModels({ data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]));
  assert("openai: empty object → []", eq(parseOpenAiModels({}), []));
  assert("openai: null → []", eq(parseOpenAiModels(null), []));
  assert("openai: string → []", eq(parseOpenAiModels("nope"), []));
  assert("openai: data not array → []", eq(parseOpenAiModels({ data: { id: "x" } }), []));
  assert(
    "openai: filters non-string / empty ids",
    eq(parseOpenAiModels({ data: [{ id: "a" }, { id: 5 }, {}, { id: "" }, null] }), ["a"]),
  );
  // shape Ollama actually serves at /v1/models (OpenAI-compatible)
  assert(
    "openai: ollama /v1 shape",
    eq(parseOpenAiModels({ object: "list", data: [{ id: "llama3.1:8b", object: "model" }] }), ["llama3.1:8b"]),
  );

  // ---- parseOllamaTags ---------------------------------------------------
  assert("ollama: extracts names", eq(parseOllamaTags({ models: [{ name: "x" }, { name: "y" }] }), ["x", "y"]));
  assert("ollama: empty → []", eq(parseOllamaTags({}), []));
  assert("ollama: null → []", eq(parseOllamaTags(null), []));
  assert("ollama: filters junk", eq(parseOllamaTags({ models: [{ name: "x" }, {}, { name: 3 }] }), ["x"]));

  // ---- pickDefaultModel --------------------------------------------------
  assert("pick: prefers llama3.1 over earlier mistral", pickDefaultModel(["mistral", "llama3.1:8b", "qwen2.5"]) === "llama3.1:8b");
  assert("pick: falls to qwen2.5 when no llama", pickDefaultModel(["mistral", "qwen2.5:7b"]) === "qwen2.5:7b");
  assert("pick: case-insensitive", pickDefaultModel(["CodeLlama", "Llama3.1-Instruct"]) === "Llama3.1-Instruct");
  assert("pick: first when no preferred", pickDefaultModel(["foo-1", "bar-2"]) === "foo-1");
  assert("pick: empty → undefined", pickDefaultModel([]) === undefined);

  // ---- buildLocalProvider ------------------------------------------------
  const prov = buildLocalProvider("http://127.0.0.1:11434/v1", "llama3.1");
  assert("provider: base_url", prov.base_url === "http://127.0.0.1:11434/v1");
  assert("provider: default_model", prov.default_model === "llama3.1");
  assert("provider: keyless (no api_key_ref)", !("api_key_ref" in prov));

  // ---- withLocalProvider: create council from nothing --------------------
  {
    const cfg = baseCfg(undefined);
    const before = JSON.stringify(cfg);
    const r = withLocalProvider(cfg, prov);
    assert("wire(empty): changed", r.changed === true);
    assert("wire(empty): enabled true", r.enabled === true);
    assert("wire(empty): no note", r.note === undefined);
    assert("wire(empty): local set", eq(r.config.settings.council.providers.local, prov));
    assert("wire(empty): council enabled in config", r.config.settings.council.enabled === true);
    assert("wire(empty): input NOT mutated", JSON.stringify(cfg) === before);
  }

  // ---- withLocalProvider: idempotent -------------------------------------
  {
    const r1 = withLocalProvider(baseCfg(undefined), prov);
    const r2 = withLocalProvider(r1.config, prov);
    assert("wire(idempotent): second pass no change", r2.changed === false);
    assert("wire(idempotent): provider stable", eq(r2.config.settings.council.providers.local, prov));
  }

  // ---- withLocalProvider: respects explicit enabled:false ----------------
  {
    const cfg = baseCfg({ council: { enabled: false } });
    const r = withLocalProvider(cfg, prov);
    assert("wire(opt-out): stays disabled", r.enabled === false);
    assert("wire(opt-out): emits note", typeof r.note === "string" && r.note.includes("enabled"));
    assert("wire(opt-out): local still set", eq(r.config.settings.council.providers.local, prov));
    assert("wire(opt-out): enabled untouched", r.config.settings.council.enabled === false);
  }

  // ---- withLocalProvider: preserves sibling providers & settings ---------
  {
    const cfg = baseCfg({
      redact_response: { enabled: true },
      council: { enabled: true, providers: { anthropic: { api_key_ref: "${vault:anthropic}", default_model: "claude" } } },
    });
    const r = withLocalProvider(cfg, prov);
    assert("wire(merge): keeps anthropic", eq(r.config.settings.council.providers.anthropic, { api_key_ref: "${vault:anthropic}", default_model: "claude" }));
    assert("wire(merge): adds local", eq(r.config.settings.council.providers.local, prov));
    assert("wire(merge): keeps unrelated setting", eq(r.config.settings.redact_response, { enabled: true }));
  }

  // ---- installGuide ------------------------------------------------------
  for (const plat of ["win32", "darwin", "linux"]) {
    const steps = installGuide(plat);
    assert(`guide(${plat}): ≥4 steps`, steps.length >= 4, `${steps.length} steps`);
    assert(`guide(${plat}): all strings`, steps.every((s) => typeof s === "string"));
    assert(`guide(${plat}): mentions \`ollama pull\``, steps.some((s) => s.includes("ollama pull")));
    assert(`guide(${plat}): names the /v1 endpoint`, steps.some((s) => s.includes("127.0.0.1:11434/v1")));
  }
  assert("guide(win32): windows installer", installGuide("win32")[0].includes("download/windows"));
  assert("guide(darwin): brew", installGuide("darwin")[0].includes("brew install ollama"));
  assert("guide(linux): install.sh", installGuide("linux")[0].includes("install.sh"));

  // ---- real config round-trip: wired block survives the zod schema -------
  {
    const wired = withLocalProvider(starterConfig(), prov);
    const p = join(root, "switchboard.config.yaml");
    writeConfig(p, wired.config);
    const reloaded = loadConfig(p); // throws if the merged config is schema-invalid
    assert("roundtrip: local provider survives load", eq(reloaded.settings.council.providers.local, prov));
    assert("roundtrip: council enabled survives load", reloaded.settings.council.enabled === true);
    assert("roundtrip: starter server preserved", reloaded.servers.length === 1 && reloaded.servers[0].id === "everything");
  }

  // ---- classifyModel: chat vs non-chat name heuristics -------------------
  for (const m of ["llama3.1:8b", "qwen2.5:7b-instruct", "mistral-nemo", "gpt-oss:20b", "deepseek-r1:7b", "gemma2"]) {
    assert(`classify: '${m}' → chat`, classifyModel(m) === "chat");
  }
  assert("classify: nomic-embed-text → embedding", classifyModel("nomic-embed-text") === "embedding");
  assert("classify: mxbai-embed-large → embedding", classifyModel("mxbai-embed-large") === "embedding");
  assert("classify: bge-large → embedding", classifyModel("bge-large-en") === "embedding");
  assert("classify: snowflake-arctic-embed → embedding", classifyModel("snowflake-arctic-embed") === "embedding");
  assert("classify: bge-reranker → rerank", classifyModel("bge-reranker-v2-m3") === "rerank");
  assert("classify: whisper → speech", classifyModel("whisper-large-v3") === "speech");
  assert("classify: sdxl → image", classifyModel("sdxl-turbo") === "image");
  assert("classify: case-insensitive (NOMIC-EMBED)", classifyModel("NOMIC-EMBED-TEXT") === "embedding");

  // ---- pickDefaultModel: chat-aware fallback (the embedding footgun) ------
  // preferred family still wins even when an embedding model sorts first
  assert("pick: preferred beats leading embedding", pickDefaultModel(["nomic-embed-text", "mistral-7b"]) === "mistral-7b");
  // no preferred family: SKIP the embedding model and take the chat-looking one
  assert("pick: skips embedding when a chat model exists", pickDefaultModel(["nomic-embed-text", "my-custom-chat:latest"]) === "my-custom-chat:latest");
  assert("pick: skips reranker for chat", pickDefaultModel(["bge-reranker-v2", "some-instruct"]) === "some-instruct");
  // only a non-chat model loaded: fall back to it (caller warns) rather than returning undefined
  assert("pick: embedding-only falls back to it", pickDefaultModel(["nomic-embed-text"]) === "nomic-embed-text");
  // regression: the pre-existing 'first when no preferred' contract is unchanged (neither is non-chat)
  assert("pick: first-when-no-preferred unchanged", pickDefaultModel(["foo-1", "bar-2"]) === "foo-1");

  // ---- wireAdvice: centralized, model-aware after-wire guidance ----------
  {
    // enabled council, chat model, only the local provider → enabled-line + single-voice hint
    const r = withLocalProvider(baseCfg(undefined), prov);
    const adv = wireAdvice(r, "llama3.1");
    assert("advice(enabled,solo): 2 lines", adv.length === 2, `${adv.length}`);
    assert("advice(enabled,solo): announces enabled", adv[0].includes("council is enabled"));
    assert("advice(enabled,solo): single-voice hint", adv[1].includes("council_debate") && adv[1].includes("two providers"));
    assert("advice(enabled,solo): no warning prefix", !adv[0].toLowerCase().includes("looks like"));
  }
  {
    // enabled council with a sibling cloud provider → no single-voice hint
    const cfg = baseCfg({ council: { enabled: true, providers: { anthropic: { api_key_ref: "${vault:anthropic}", default_model: "claude" } } } });
    const r = withLocalProvider(cfg, prov);
    const adv = wireAdvice(r, "llama3.1");
    assert("advice(enabled,two): 1 line", adv.length === 1, `${adv.length}`);
    assert("advice(enabled,two): enabled line", adv[0].includes("council is enabled"));
    assert("advice(enabled,two): no single-voice hint", !adv.some((l) => l.includes("two providers")));
  }
  {
    // council explicitly disabled → surface only the disabled note
    const r = withLocalProvider(baseCfg({ council: { enabled: false } }), prov);
    const adv = wireAdvice(r, "llama3.1");
    assert("advice(disabled): 1 line", adv.length === 1, `${adv.length}`);
    assert("advice(disabled): names enabled flag", adv[0].includes("enabled"));
    assert("advice(disabled): not the run hint", !adv[0].includes("switchboard serve"));
  }
  {
    // embedding model wired → correctness WARNING first, then the normal lines
    const r = withLocalProvider(baseCfg(undefined), buildLocalProvider("http://127.0.0.1:11434/v1", "nomic-embed-text"));
    const adv = wireAdvice(r, "nomic-embed-text");
    assert("advice(embed): warning + enabled + hint = 3 lines", adv.length === 3, `${adv.length}`);
    assert("advice(embed): warning is first", adv[0].includes("nomic-embed-text") && adv[0].includes("embedding"));
    assert("advice(embed): warning uses 'an'", adv[0].includes("an embedding"));
    assert("advice(embed): warning steers to chat", adv[0].includes("chat/instruct"));
    assert("advice(embed): still shows enabled line", adv[1].includes("council is enabled"));
  }
  {
    // speech model → 'a speech' article (proves the article branch)
    const r = withLocalProvider(baseCfg(undefined), buildLocalProvider("http://127.0.0.1:11434/v1", "whisper-large-v3"));
    const adv = wireAdvice(r, "whisper-large-v3");
    assert("advice(speech): 'a speech' article", adv[0].includes("a speech model"));
  }
  {
    // purity: wireAdvice must not mutate the WireResult it is handed
    const r = withLocalProvider(baseCfg(undefined), prov);
    const snapshot = JSON.stringify(r);
    wireAdvice(r, "llama3.1");
    assert("advice: does not mutate the result", JSON.stringify(r) === snapshot);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) console.log("FAILED:", failed.map((c) => c.name).join(", "));
process.exitCode = failed.length === 0 ? 0 : 1;
