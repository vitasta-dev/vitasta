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
  /** The usage is in a test, example or fixture file */
  inTest?: boolean;
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
  /** Found by comparing published API specs, not yet confirmed by a changelog or deprecation notice */
  unconfirmed?: boolean;
  /** New in the feed and not yet checked by a person. Reported as a note; never fails a PR check. */
  pending?: boolean;
  /** How the break is triggered: on the date, or only when you upgrade the API version / SDK */
  trigger: "date" | "upgrade";
  replacement?: string;
  guide?: string;
  sources: { url: string; note?: string; checked?: string }[];
}

export interface Finding {
  change: ChangeRecord;
  usage: Usage;
  /** Negative = already past the effective date */
  daysLeft: number;
  status: "broken" | "urgent" | "upcoming" | "on-upgrade";
}
