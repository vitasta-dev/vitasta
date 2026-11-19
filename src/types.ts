export type Lang = "ts" | "js" | "py" | "java" | "go" | "rb" | "php" | "cs";

export type Confidence = "certain" | "likely" | "possible";

/** A range in the file's text (JavaScript string indexes, end exclusive) */
export interface Span {
  start: number;
  end: number;
}

/** Where the model ID is written, so a fix can replace exactly that text */
export interface ModelSpan extends Span {
  /** "string": a quoted literal (the span includes the quotes); "bare": an unquoted token (config files);
   *  "java-const": an SDK constant like Model.CLAUDE_3_HAIKU_20240307 */
  kind: "string" | "bare" | "java-const";
}

/** One place in the code that talks to a third-party API. */
export interface Usage {
  provider: string;
  /** sdk = call through the official SDK; http = raw HTTP call; model-ref = a model ID string outside a call; version-pin = a pinned API version */
  kind: "sdk" | "http" | "model-ref" | "version-pin";
  /** Source language, or "config" for YAML/JSON/TOML/.env files and "notebook" for Jupyter code cells */
  lang: Lang | "config" | "notebook";
  file: string;
  line: number;
  /** HTTP operation, e.g. "POST /v1/messages", when known */
  op?: string;
  /** SDK call path, e.g. "chat.completions.create" */
  sdkCall?: string;
  /** Model ID passed to the call, when it could be resolved */
  model?: string;
  /** Names of the parameters passed to the call */
  params?: string[];
  /** Pinned API version (header value, URL segment or SDK option) */
  apiVersion?: string;
  confidence: Confidence;
  snippet: string;
  /** Set when the model is served by a cloud host with its own retirement schedule (Azure, Bedrock, Vertex) */
  host?: "azure" | "bedrock" | "vertex";
  /**
   * Set when the model is reached through something that isn't the provider's API (GitHub Models, Copilot, the
   * ChatGPT app, VS Code's model API): the provider's API retirement dates don't apply. A readable name.
   */
  via?: string;
  /** Internal, during a scan: the module-level name of the model list this came from */
  owner?: string;
  /** The usage is in a test, example or fixture file */
  inTest?: boolean;
  /** Found in documentation: a Markdown code block or a code sample held in a string. Reported, never fails a PR */
  doc?: boolean;
  /** What this place is for (src/scan/roles.ts): decides how it's reported, whether it fails a check, what a fix does */
  role?: "breaks" | "users-copy" | "test-asserts" | "test-data" | "catalog" | "recorded";
  /** Describes a call that already happened (telemetry, a recorded response): reported as info, never edited */
  recorded?: boolean;
  /** Why a place that isn't a use is reported anyway (a price table, a recorded response, a list only checked against) */
  reason?: string;
  /** Found as a model setting (model=…, a default, an option), not only as a string in data */
  setting?: boolean;
  /** The client talks to a different server (an OpenAI-compatible relay or gateway); the provider's dates may not apply */
  proxy?: string;
  /** The SDK used when it belongs to another provider (OpenAI SDK calling Groq's compatible endpoint) */
  viaSdk?: string;
  /** Where the model ID literal is in this file (it may be a constant defined elsewhere in the file) */
  modelSpan?: ModelSpan;
  /** Other lines that belong to this usage (the model literal, parameters) when they aren't on `line`: a PR that
   *  changes any of them changes the usage */
  alsoLines?: number[];
  /**
   * The model is offered, not necessarily used: an entry in a model list, picker, registry or type union. Reported,
   * but never fails a PR check, and listed after the places that call a model.
   */
  listed?: boolean;
  /** Internal: found through a code shape only; kept when the repo shows it uses this provider (scan/evidence.ts) */
  weak?: boolean;
  /** Set when the usage was found from an ID of the provider's own object (e.g. an OpenAI prompt object ID) */
  resource?: string;
  /** Removal range for each parameter passed to the call (object property, keyword argument, Java setter) */
  paramSpans?: Record<string, Span>;
}

export interface SdkDependency {
  provider: string;
  lang: Lang;
  name: string;
  version?: string;
  manifest: string;
}

/** The API bill of materials for one repo. */
export interface ApiMap {
  root: string;
  scannedAt: string;
  filesScanned: number;
  sdks: SdkDependency[];
  usages: Usage[];
  /** The repo's .vitasta.yml, if any (custom changes, policy) */
  config?: import("./config.js").RepoConfig;
}

export type ChangeType =
  | "model_retirement"
  | "model_deprecation"
  | "endpoint_shutdown"
  | "param_removed"
  | "sdk_api_removed"
  | "version_sunset";

/** One provider change from the feed. */
export interface ChangeRecord {
  id: string;
  provider: string;
  type: ChangeType;
  title: string;
  /** What the change targets. Every field that is set must match. */
  selector: {
    /** Model IDs or prefixes ending in "*" */
    models?: string[];
    /** Operation prefixes, e.g. "POST /v1/assistants" or "* /v1/threads" */
    ops?: string[];
    /** Parameter names on matching calls */
    params?: string[];
    /** SDK call paths, e.g. "ChatCompletion.create" */
    sdkCalls?: string[];
    /** Only applies when the model is served through these cloud hosts. Unset = the provider's own API. */
    hosts?: ("bedrock" | "vertex" | "azure")[];
    /** Pinned API versions this applies to, e.g. "2025-07" (Shopify) or "v21.0" (Meta Graph) */
    versions?: string[];
  };
  announced?: string;
  /** Date the change takes effect (YYYY-MM-DD) */
  effective: string;
  /** The date is the earliest possible shutdown ("not sooner than"), not a firm one */
  earliest?: boolean;
  /**
   * What happens on the date. Unset: it stops working ("shutdown"), or `earliest` above.
   *   auto-route: calls keep working but the provider sends them to another model (`routesTo`), with no change on
   *               the user's side, so behaviour, cost or output can change silently
   *   read-only:  existing data stays readable; creating or changing it stops (the listed operations fail)
   */
  dateKind?: "shutdown" | "earliest" | "auto-route" | "read-only";
  /** auto-route: the model calls go to from the date on */
  routesTo?: string;
  /**
   * A model whose versions retire on different dates (Azure): each version's date. `effective` is the next one.
   * Code rarely says which version a deployment runs, so until the last date it's "some versions retired", not "broken".
   */
  modelVersions?: { version: string; effective: string; earliest?: boolean }[];
  /** Found by comparing published API specs, not yet confirmed by a changelog or deprecation notice */
  unconfirmed?: boolean;
  /** New in the feed and not yet checked by a person. Reported as a note; never fails a PR check. */
  pending?: boolean;
  /** How the break is triggered: on the date, or only when you upgrade the API version / SDK */
  trigger: "date" | "upgrade";
  replacement?: string;
  /** Set on a copy when Vitasta follows the named replacement to another model (it was itself retiring) */
  namedReplacement?: string;
  guide?: string;
  sources: { url: string; note?: string; checked?: string }[];
}

export interface Finding {
  change: ChangeRecord;
  /** What to move to, resolved through the feed (the named replacement may itself be retiring); see feed/replacement.ts */
  moveTo?: import("./feed/replacement.js").MoveTo;
  usage: Usage;
  /** Negative = already past the effective date */
  daysLeft: number;
  status: "broken" | "urgent" | "upcoming" | "on-upgrade";
}
