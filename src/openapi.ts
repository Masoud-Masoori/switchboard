/**
 * app2mcp — OpenAPI / Swagger → generated MCP server (Phase 4).
 *
 * Turns an OpenAPI 3.x or Swagger 2.0 spec into a real in-process MCP `Server`:
 * each operation (path × method) becomes one tool whose `inputSchema` is the
 * flattened union of its path / query / header parameters and JSON request body.
 * Tool calls are executed with the global `fetch` (Node ≥18.18) — **zero deps**.
 *
 * Scope inference follows the project rule: GET/HEAD → read, POST/PUT/PATCH →
 * write, DELETE → full. The generated server does NOT itself enforce scope — the
 * gateway's Router/Policy engine governs every call before it reaches here — but
 * it surfaces a per-tool `scopeHints` map so the policy engine classifies each
 * generated tool by its HTTP verb instead of guessing from the tool name.
 *
 * Auth is injected per call via `resolveHeaders()` (so OAuth tokens refresh) and
 * merged with any per-operation header parameters.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Scope, ServerConfig } from "./types.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const MAX_RESPONSE_CHARS = 50_000;

type ParamLocation = "path" | "query" | "header" | "body";

interface FlatParam {
  location: ParamLocation;
  /** The real name to send upstream. `__body__` means "the entire request body". */
  originalName: string;
  required: boolean;
}

interface GeneratedOp {
  toolName: string;
  method: string; // upper-case HTTP method
  pathTemplate: string; // e.g. /pet/{petId}
  scope: Scope;
  bodyMode: "none" | "merged" | "nested";
  bodyContentType: "json" | "form";
  flat: Record<string, FlatParam>;
}

export interface OpenApiServer {
  server: Server;
  scopeHints: Record<string, Scope>;
  toolCount: number;
}

/** GET/HEAD/OPTIONS/TRACE → read, DELETE → full, everything else → write. */
function scopeForMethod(method: string): Scope {
  const m = method.toLowerCase();
  if (m === "get" || m === "head" || m === "options" || m === "trace") return "read";
  if (m === "delete") return "full";
  return "write";
}

/**
 * Build a `$ref` resolver over `root`. References are inlined; a `$ref` that is
 * already being expanded on the current branch resolves to `{}` (circular guard),
 * and a dangling pointer resolves to `{}` (fail-soft, never throw mid-generation).
 * Supports OpenAPI 3.x (`#/components/...`) and Swagger 2.0 (`#/definitions/...`).
 */
function makeDeref(root: unknown): (node: unknown) => any {
  function resolvePointer(ref: string): unknown {
    if (!ref.startsWith("#/")) return undefined;
    const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    let cur: any = root;
    for (const part of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[part];
    }
    return cur;
  }
  function deref(node: any, active: Set<string>): any {
    if (node == null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((n) => deref(n, active));
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (active.has(ref)) return {};
      const target = resolvePointer(ref);
      if (target === undefined) return {};
      const next = new Set(active);
      next.add(ref);
      return deref(target, next);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deref(v, active);
    return out;
  }
  return (node: unknown) => deref(node, new Set<string>());
}

/** Coerce an OpenAPI/Swagger parameter into a JSON Schema fragment. */
function paramSchema(param: any, deref: (n: unknown) => any): any {
  if (param.schema) return deref(param.schema); // OpenAPI 3.x
  // Swagger 2.0 inline typing.
  const schema: any = { type: param.type ?? "string" };
  if (param.format) schema.format = param.format;
  if (param.items) schema.items = deref(param.items);
  if (param.enum) schema.enum = param.enum;
  if (param.description) schema.description = param.description;
  return schema;
}

/** Sanitize to the MCP tool-name charset `[a-z0-9_-]{1,64}`, truncated for headroom. */
function sanitizeName(raw: string): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  name = name.replace(/_+/g, "_").replace(/^[_-]+/, "");
  if (name.length === 0) name = "op";
  if (name.length > 56) name = name.slice(0, 56).replace(/[_-]+$/, "");
  return name;
}

/** A key not already present in `taken`, suffixed `_2`, `_3`, … on collision. */
function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/** Load + parse a spec from a local path or http(s) URL. YAML parser also reads JSON. */
async function loadSpec(source: string): Promise<any> {
  let raw: string;
  if (/^https?:\/\//i.test(source)) {
    const resp = await fetch(source);
    if (!resp.ok) {
      throw new Error(`failed to fetch OpenAPI spec '${source}': HTTP ${resp.status}`);
    }
    raw = await resp.text();
  } else {
    raw = readFileSync(resolvePath(source), "utf8");
  }
  const parsed = parseYaml(raw);
  if (parsed == null || typeof parsed !== "object") {
    throw new Error(`OpenAPI spec '${source}' did not parse to an object`);
  }
  return parsed;
}

/**
 * Derive the absolute base URL. Precedence: explicit `config.base_url` >
 * OpenAPI 3.x `servers[0].url` (with `{var}` defaults substituted) > Swagger 2.0
 * `schemes`+`host`+`basePath`. Fail closed (throw) if none yields an absolute URL —
 * we never invent a host or silently call a relative path.
 */
function deriveBaseUrl(config: ServerConfig, spec: any, isSwagger2: boolean): string {
  if (config.base_url) return config.base_url.replace(/\/$/, "");

  if (isSwagger2) {
    if (!spec.host) {
      throw new Error(`server '${config.id}': Swagger 2.0 spec has no 'host'; set base_url in the config`);
    }
    const schemes: string[] = Array.isArray(spec.schemes) && spec.schemes.length ? spec.schemes : ["https"];
    const scheme = schemes.includes("https") ? "https" : schemes[0];
    return `${scheme}://${spec.host}${spec.basePath ?? ""}`.replace(/\/$/, "");
  }

  const server = spec.servers?.[0];
  let url: string | undefined = server?.url;
  if (!url) {
    throw new Error(`server '${config.id}': spec has no servers[0].url; set base_url in the config`);
  }
  const vars = server.variables ?? {};
  url = url.replace(/\{([^}]+)\}/g, (_m: string, name: string) => vars[name]?.default ?? `{${name}}`);
  if (url.startsWith("/")) {
    throw new Error(`server '${config.id}': servers[0].url '${url}' is relative; set base_url in the config`);
  }
  return url.replace(/\/$/, "");
}

/** Flatten one operation into a tool definition + an invocation plan. */
function buildOperation(
  rawPath: string,
  method: string,
  op: any,
  pathLevelParams: any[],
  deref: (n: unknown) => any,
  takenToolNames: Set<string>,
): { tool: Tool; plan: GeneratedOp } {
  const candidate = op["x-mcp-tool-name"] ?? op.operationId ?? `${method}_${sanitizeName(rawPath)}`;
  const toolName = uniqueKey(sanitizeName(String(candidate)), takenToolNames);
  takenToolNames.add(toolName);

  const properties: Record<string, any> = {};
  const required: string[] = [];
  const flat: Record<string, FlatParam> = {};
  const takenKeys = new Set<string>();

  // --- parameters (path / query / header); body/formData handled separately ---
  const rawParams: any[] = [...pathLevelParams, ...(op.parameters ?? [])].map((p) => deref(p));
  const valueParams = rawParams.filter((p) => p.in === "path" || p.in === "query" || p.in === "header");
  for (const p of valueParams) {
    if (!p.name || !p.in) continue;
    const key = uniqueKey(p.name, takenKeys);
    takenKeys.add(key);
    const schema = paramSchema(p, deref);
    if (p.description && !schema.description) schema.description = p.description;
    properties[key] = schema;
    if (p.required) required.push(key);
    flat[key] = { location: p.in as ParamLocation, originalName: p.name, required: Boolean(p.required) };
  }

  // --- request body (OpenAPI 3.x requestBody, Swagger 2.0 in:body / in:formData) ---
  let bodySchema: any;
  let bodyRequired = false;
  let bodyContentType: "json" | "form" = "json";

  if (op.requestBody) {
    const rb = deref(op.requestBody);
    bodyRequired = Boolean(rb.required);
    const content: Record<string, any> = rb.content ?? {};
    if (content["application/json"]?.schema) {
      bodySchema = content["application/json"].schema;
    } else if (content["application/x-www-form-urlencoded"]?.schema) {
      bodySchema = content["application/x-www-form-urlencoded"].schema;
      bodyContentType = "form";
    } else {
      const first = Object.values(content)[0];
      if (first?.schema) bodySchema = first.schema;
    }
  } else {
    const bodyParam = rawParams.find((p) => p.in === "body"); // Swagger 2.0
    const formParams = rawParams.filter((p) => p.in === "formData"); // Swagger 2.0
    if (bodyParam?.schema) {
      bodySchema = bodyParam.schema;
      bodyRequired = Boolean(bodyParam.required);
    } else if (formParams.length) {
      bodyContentType = "form";
      bodySchema = {
        type: "object",
        properties: Object.fromEntries(formParams.map((f) => [f.name, paramSchema(f, deref)])),
        required: formParams.filter((f) => f.required).map((f) => f.name),
      };
      bodyRequired = formParams.some((f) => f.required);
    }
  }

  let bodyMode: GeneratedOp["bodyMode"] = "none";
  if (bodySchema) {
    const bs = deref(bodySchema);
    const props: Record<string, any> | undefined =
      bs && bs.type === "object" && bs.properties && typeof bs.properties === "object" ? bs.properties : undefined;
    const collides = props ? Object.keys(props).some((k) => k in properties) : true;
    if (props && !collides) {
      // Merge object body fields up to the top level (the common, ergonomic case).
      bodyMode = "merged";
      const bodyReq: string[] = Array.isArray(bs.required) ? bs.required : [];
      for (const [k, sub] of Object.entries(props)) {
        properties[k] = sub;
        flat[k] = { location: "body", originalName: k, required: bodyReq.includes(k) };
        if (bodyReq.includes(k)) required.push(k);
      }
    } else {
      // Non-object body, or a name collision with a path/query/header param → nest it.
      bodyMode = "nested";
      const key = uniqueKey("body", takenKeys);
      takenKeys.add(key);
      properties[key] = bs;
      flat[key] = { location: "body", originalName: "__body__", required: bodyRequired };
      if (bodyRequired) required.push(key);
    }
  }

  const description = String(op.summary ?? op.description ?? `${method.toUpperCase()} ${rawPath}`).slice(0, 400);
  const tool: Tool = {
    name: toolName,
    description,
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
  };
  const plan: GeneratedOp = {
    toolName,
    method: method.toUpperCase(),
    pathTemplate: rawPath,
    scope: scopeForMethod(method),
    bodyMode,
    bodyContentType,
    flat,
  };
  return { tool, plan };
}

/** Execute one generated operation as an HTTP request and shape the MCP result. */
async function invokeOperation(
  baseUrl: string,
  op: GeneratedOp,
  args: Record<string, unknown>,
  authHeaders: Record<string, string>,
): Promise<CallToolResult> {
  let path = op.pathTemplate;
  const queryPairs: [string, string][] = [];
  const headers: Record<string, string> = { accept: "application/json", ...authHeaders };
  const mergedBody: Record<string, unknown> = {};
  let wholeBody: unknown;
  let haveWholeBody = false;

  for (const [key, meta] of Object.entries(op.flat)) {
    if (!(key in args)) continue;
    const value = args[key];
    if (value === undefined) continue;
    switch (meta.location) {
      case "path": {
        const serialized = Array.isArray(value) ? value.join(",") : String(value);
        path = path.replace(`{${meta.originalName}}`, encodeURIComponent(serialized));
        break;
      }
      case "query": {
        if (Array.isArray(value)) {
          for (const v of value) queryPairs.push([meta.originalName, String(v)]);
        } else if (value !== null) {
          queryPairs.push([meta.originalName, String(value)]);
        }
        break;
      }
      case "header": {
        if (value !== null) headers[meta.originalName] = String(value);
        break;
      }
      case "body": {
        if (meta.originalName === "__body__") {
          wholeBody = value;
          haveWholeBody = true;
        } else {
          mergedBody[meta.originalName] = value;
        }
        break;
      }
    }
  }

  const url = new URL(baseUrl + path);
  for (const [k, v] of queryPairs) url.searchParams.append(k, v);

  const init: RequestInit = { method: op.method, headers };
  const sendsBody = op.method !== "GET" && op.method !== "HEAD";
  let body: unknown;
  if (haveWholeBody) body = wholeBody;
  else if (op.bodyMode === "merged" && Object.keys(mergedBody).length) body = mergedBody;

  if (sendsBody && body !== undefined) {
    if (op.bodyContentType === "form" && body !== null && typeof body === "object") {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) form.append(k, String(v));
      init.body = form.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else {
      init.body = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
  }

  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    return {
      content: [{ type: "text", text: `request to ${op.method} ${url.pathname} failed: ${(err as Error).message}` }],
      isError: true,
    };
  }

  const text = await resp.text();
  const shown =
    text.length > MAX_RESPONSE_CHARS
      ? `${text.slice(0, MAX_RESPONSE_CHARS)}\n…[truncated ${text.length - MAX_RESPONSE_CHARS} chars]`
      : text;
  return {
    content: [{ type: "text", text: `HTTP ${resp.status} ${resp.statusText}\n\n${shown}` }],
    isError: resp.status >= 400,
  };
}

/**
 * Build an in-process MCP `Server` from an OpenAPI/Swagger spec. The registry
 * links this server to a real SDK `Client` over an in-memory transport, so the
 * rest of the gateway treats it identically to a mounted external server.
 *
 * @param resolveHeaders called per tool-call to produce auth headers (e.g.
 *   `{ Authorization: "Bearer …" }`) — async so OAuth tokens can refresh.
 */
export async function buildOpenApiServer(
  config: ServerConfig,
  resolveHeaders: () => Promise<Record<string, string>>,
): Promise<OpenApiServer> {
  if (!config.openapi) {
    throw new Error(`server '${config.id}': source 'app2mcp' requires an 'openapi' spec path or URL`);
  }

  const spec = await loadSpec(config.openapi);
  const isSwagger2 = typeof spec.swagger === "string" && spec.swagger.startsWith("2");
  if (!isSwagger2 && !spec.openapi) {
    throw new Error(`server '${config.id}': '${config.openapi}' is neither OpenAPI 3.x nor Swagger 2.0`);
  }

  const baseUrl = deriveBaseUrl(config, spec, isSwagger2);
  const deref = makeDeref(spec);

  const tools: Tool[] = [];
  const plans = new Map<string, GeneratedOp>();
  const scopeHints: Record<string, Scope> = {};
  const takenToolNames = new Set<string>();
  const warnings: string[] = [];

  const paths: Record<string, any> = spec.paths ?? {};
  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathLevelParams: any[] = Array.isArray((pathItem as any).parameters) ? (pathItem as any).parameters : [];
    for (const method of HTTP_METHODS) {
      const op = (pathItem as any)[method];
      if (!op || typeof op !== "object") continue;
      try {
        const { tool, plan } = buildOperation(rawPath, method, op, pathLevelParams, deref, takenToolNames);
        tools.push(tool);
        plans.set(tool.name, plan);
        scopeHints[tool.name] = plan.scope;
      } catch (err) {
        // Validate-but-warn: a single malformed operation never kills the mount.
        warnings.push(`${method.toUpperCase()} ${rawPath}: ${(err as Error).message}`);
      }
    }
  }

  if (tools.length === 0) {
    throw new Error(`server '${config.id}': OpenAPI spec '${config.openapi}' yielded zero callable operations`);
  }
  if (warnings.length) {
    console.error(`[switchboard] app2mcp '${config.id}' skipped ${warnings.length} operation(s):`);
    for (const w of warnings) console.error(`  - ${w}`);
  }

  const server = new Server(
    { name: `switchboard-openapi:${config.id}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const plan = plans.get(request.params.name);
    if (!plan) {
      return { content: [{ type: "text", text: `unknown tool '${request.params.name}'` }], isError: true };
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let authHeaders: Record<string, string>;
    try {
      authHeaders = await resolveHeaders();
    } catch (err) {
      // Fail closed: a missing/expired credential must not silently send an unauthenticated call.
      return { content: [{ type: "text", text: `credential error: ${(err as Error).message}` }], isError: true };
    }
    return invokeOperation(baseUrl, plan, args, authHeaders);
  });

  return { server, scopeHints, toolCount: tools.length };
}
