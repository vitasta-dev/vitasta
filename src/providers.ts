import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lang } from "./types.js";

const GITHUB_OPS: Record<string, string> = createRequire(import.meta.url)("./data/github-ops.json");

/** Partner vendors' model IDs on Azure and Bedrock, by vendor family (src/data/partner-models.json) */
interface PartnerData {
  bedrock: { regionPrefixes: string[]; namespaces: Record<string, string> };
  azure: { families: { provider: string; pattern: string }[] };
}
const PARTNERS: PartnerData = createRequire(import.meta.url)("./data/partner-models.json");

export interface ProviderDef {
  id: string;
  /** Exported names that construct a client (class or factory) */
  clientClasses: string[];
  /** Package names of the official SDK, per language */
  packages: Partial<Record<Lang, string[]>>;
  /** Hosts its HTTP API lives on */
  hosts: string[];
  /** Headers that pin an API version */
  versionHeaders: string[];
  /** Strings that look like this provider's model IDs */
  modelPattern: RegExp;
  /** SDK call path (after the client) → HTTP operation. Longest prefix wins. */
  sdkOps: Record<string, string>;
  /** Rule-based mapping when there's no table entry (e.g. Stripe's resource naming) */
  opFor?: (callPath: string) => string | undefined;
  /** Leading call-path segments to drop before mapping, e.g. "rest." in octokit.rest.repos.get */
  stripPrefix?: RegExp;
  /** Object keys / keyword arguments that pin an API version (Stripe apiVersion, Shopify apiVersion, Meta api_version) */
  versionKeys?: string[];
  /** Pulls a pinned version out of a request URL: Shopify /admin/api/2025-07/, Meta /v21.0/ */
  urlVersion?: RegExp;
  /** The urlVersion path is this provider's alone, so a URL counts even when its host is a variable (built-in only) */
  urlVersionStandsAlone?: boolean;
  /** v9: SDK paths that run locally and never call the API (signature checks, error classes) */
  localOps?: RegExp;
  /** v7: hosts that count only for a versioned URL (a login dialog on the provider's website), never as API calls */
  versionOnlyHosts?: string[];
  /** v7: the exact shape of a version token ("v14.0", "2026-10"), for versions written outside a full URL */
  versionToken?: RegExp;
  /**
   * v10: SDK calls and settings that pin the API version, in any language (Stripe::setApiVersion('…'),
   * Stripe.api_version = '…', StripeVersion = "…", GraphAPI(version='3.1'), Version.VERSION_19_0). The first capture
   * is the version; `fmt` rewrites the captures into the feed's form; `needs` is a word the file must contain.
   */
  versionSetters?: { re: RegExp; fmt?: (m: RegExpExecArray) => string; needs?: RegExp; ident?: boolean }[];
  /** v14: a versioned path that counts only after one of the hosts (Shopify Storefront: myshopify.com/api/2025-01/) */
  hostUrlVersion?: RegExp;
  /** v7: words in a file or path that tie code to this provider (hosts, product names) */
  versionEvidence?: RegExp;
  /** v7: words on a line that point to another API with the same version shape (Threads' v1.0 isn't Graph's) */
  notEvidence?: RegExp;
  /** Turns an SDK version constant into the version string, e.g. ApiVersion.July25 → 2025-07 */
  versionConst?: (text: string) => string | undefined;
  /** Extra words that mark a file as possibly using this provider (for the fast file filter) */
  keywords?: string[];
  /**
   * Only URL paths matching this belong to the provider, on a host it shares with another provider (Meta's Marketing
   * API is the /vNN.0/act_… part of graph.facebook.com). Checked before host-only providers.
   */
  pathPattern?: RegExp;
  /**
   * A provider whose versions never outlive another's (Meta's Marketing API versions expire no later than the same Graph
   * API version): when this provider has no sunset record for a version, that provider's record for it is an upper
   * bound on the date ("by then at the latest"). Blind v18.0 Marketing URLs matched no record.
   */
  versionFallback?: string;
  /**
   * Model IDs safe to send to the lookup service (public IDs only), when modelPattern is too narrow or unset.
   * Tested on the lower-cased ID. Never used to decide that a loose string is a model.
   */
  publicModelPattern?: RegExp;
  /**
   * IDs of this provider's own objects that only make sense with one API call, so a quoted ID in code is a use of
   * that call even when the call itself is elsewhere (OpenAI prompt objects: "pmpt_" + 48 hex → Responses `prompt`).
   */
  resourceIds?: ResourceId[];
}

export interface ResourceId {
  /** What the ID is, for reports ("OpenAI prompt object") */
  what: string;
  /** The whole ID, anchored (^…$) */
  pattern: RegExp;
  op: string;
  params?: string[];
}

const NEVER = /(?!)/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const snakeCase = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * Stripe SDKs name methods after resources: stripe.paymentIntents.create → POST /v1/payment_intents,
 * .retrieve → GET …/{id}, .update → POST …/{id}, .list → GET, .del → DELETE …/{id}, other verbs → POST …/{id}/{verb}.
 * Python's class style (stripe.PaymentIntent.create) and StripeClient (client.v1.payment_intents.create) map the same way.
 */
function stripeOp(callPath: string): string | undefined {
  const parts = callPath.replace(/^v\d+\./, "").split(".");
  if (parts.length < 2) return undefined;
  // v13: create_async (Python), CreateAsync (C#) are the same operation
  const verb = parts.pop()!.replace(/_async$|Async$/, "");
  const res = parts.map((p) => {
    const s = snakeCase(p);
    // Python class style: PaymentIntent → payment_intents
    return /^[A-Z]/.test(p) ? (s.endsWith("s") ? s : s.endsWith("y") ? s.slice(0, -1) + "ies" : s + "s") : s;
  });
  const base = `/v1/${res.join("/")}`;
  switch (verb) {
    case "create": return `POST ${base}`;
    case "list": case "listAutoPaging": case "auto_paging_iter": case "search": return `GET ${base}`;
    case "retrieve": return `GET ${base}/{id}`;
    case "update": case "modify": return `POST ${base}/{id}`;
    case "del": case "delete": return `DELETE ${base}/{id}`;
    default: return `POST ${base}/{id}/${snakeCase(verb)}`;
  }
}

/** Twilio's shorthand resources live under the 2010 API: client.messages.create → POST /2010-04-01/Accounts/{sid}/Messages.json */
function twilioOp(callPath: string): string | undefined {
  const parts = callPath.replace(/^api\.v2010\.(accounts\.)?/, "").split(".");
  if (parts.length !== 2) return undefined;
  const [res, verb] = parts;
  const Res = res[0].toUpperCase() + res.slice(1);
  const base = `/2010-04-01/Accounts/{AccountSid}/${Res}.json`;
  if (verb === "create") return `POST ${base}`;
  if (verb === "list" || verb === "each" || verb === "page" || verb === "stream") return `GET ${base}`;
  return undefined;
}

/** Shopify's ApiVersion enum: ApiVersion.July25 → 2025-07, ApiVersion.October24 → 2024-10 */
function shopifyVersionConst(text: string): string | undefined {
  const m = /ApiVersion\.([A-Z][a-z]+)(\d{2})\b/.exec(text);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  return m && month >= 0 ? `20${m[2]}-${String(month + 1).padStart(2, "0")}` : undefined;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    resourceIds: [{ what: "OpenAI prompt object", pattern: /^pmpt_[0-9a-f]{48}$/, op: "POST /v1/responses", params: ["prompt"] }],
    clientClasses: ["OpenAI", "AsyncOpenAI", "AzureOpenAI", "AsyncAzureOpenAI", "OpenAIApi", "OpenAIOkHttpClient", "OpenAIOkHttpClientAsync"],
    packages: {
      ts: ["openai"],
      js: ["openai"],
      py: ["openai"],
      java: ["com.openai:openai-java"],
      go: ["github.com/openai/openai-go", "github.com/sashabaranov/go-openai"],
      rb: ["openai", "ruby-openai"],
      php: ["openai-php/client", "openai-php/laravel"],
      cs: ["OpenAI", "Azure.AI.OpenAI", "Betalgo.OpenAI"],
    },
    hosts: ["api.openai.com"],
    versionHeaders: ["openai-beta"],
    modelPattern:
      /^(gpt-\d[\w.-]*|gpt-image-[\w.-]+|gpt-(realtime|audio|chat)(-[\w.-]+)?|sora-\d[\w.-]*|o[1-9](-(mini|pro|preview|deep-research)[\w.-]*)?|chatgpt-4o[\w.-]*|text-(davinci|curie|babbage|ada)-\d{3}|code-(davinci|cushman)-\d{3}|text-(search|similarity)-[a-z]+-(doc|query)?-?\d{3}|text-embedding-[\w.-]+|text-moderation-[\w.-]+|omni-moderation-[\w.-]+|davinci-002|babbage-002|dall-e-[23]|whisper-1|tts-1(-hd)?|codex-mini[\w.-]*|computer-use-preview[\w.-]*)$/,
    sdkOps: {
      "chat.completions.create": "POST /v1/chat/completions",
      "chat.completions.stream": "POST /v1/chat/completions",
      "chat.completions.parse": "POST /v1/chat/completions",
      "beta.chat.completions.parse": "POST /v1/chat/completions",
      "responses.create": "POST /v1/responses",
      "responses.stream": "POST /v1/responses",
      "responses.parse": "POST /v1/responses",
      "responses.retrieve": "GET /v1/responses",
      "completions.create": "POST /v1/completions",
      "embeddings.create": "POST /v1/embeddings",
      "images.generate": "POST /v1/images/generations",
      "audio.transcriptions.create": "POST /v1/audio/transcriptions",
      "audio.translations.create": "POST /v1/audio/translations",
      "audio.speech.create": "POST /v1/audio/speech",
      "moderations.create": "POST /v1/moderations",
      "models.list": "GET /v1/models",
      "beta.assistants": "* /v1/assistants",
      "beta.threads": "* /v1/threads",
      "beta.vector_stores": "* /v1/vector_stores",
      "beta.vectorStores": "* /v1/vector_stores",
      "vector_stores": "* /v1/vector_stores",
      "vectorStores": "* /v1/vector_stores",
      "files": "* /v1/files",
      "batches": "* /v1/batches",
      "fine_tuning": "* /v1/fine_tuning",
      "fineTuning": "* /v1/fine_tuning",
      "conversations": "* /v1/conversations",
      // Legacy SDK v0 (Python openai<1.0, Node openai@3)
      "ChatCompletion.create": "POST /v1/chat/completions",
      "Completion.create": "POST /v1/completions",
      "Embedding.create": "POST /v1/embeddings",
      "createChatCompletion": "POST /v1/chat/completions",
      "createCompletion": "POST /v1/completions",
    },
  },
  {
    id: "anthropic",
    clientClasses: ["Anthropic", "AsyncAnthropic", "AnthropicBedrock", "AsyncAnthropicBedrock", "AnthropicVertex", "AsyncAnthropicVertex", "AnthropicOkHttpClient", "AnthropicOkHttpClientAsync"],
    packages: {
      ts: ["@anthropic-ai/sdk"],
      js: ["@anthropic-ai/sdk"],
      py: ["anthropic"],
      java: ["com.anthropic:anthropic-java"],
      go: ["github.com/anthropics/anthropic-sdk-go"],
      rb: ["anthropic"],
    },
    hosts: ["api.anthropic.com"],
    versionHeaders: ["anthropic-version", "anthropic-beta"],
    // claude-sonnet-4-5, Vertex "claude-sonnet-4-5@20250929", Bedrock "us.anthropic.claude-…-v1:0" and Bedrock ARNs
    modelPattern:
      /^(claude-(\d|instant|opus|sonnet|haiku|fable|mythos|v\d)[\w.@-]*|((us|eu|apac|global|us-gov|jp|au|ca|apne\d?)\.)?anthropic\.claude-[\w.:-]+|arn:aws[\w-]*:bedrock:[\w-]*:\d*:(foundation-model|inference-profile|application-inference-profile)\/[\w.:-]*anthropic\.claude-[\w.:-]+)$/,
    sdkOps: {
      "messages.create": "POST /v1/messages",
      "messages.stream": "POST /v1/messages",
      "messages.parse": "POST /v1/messages",
      "messages.countTokens": "POST /v1/messages/count_tokens",
      "messages.count_tokens": "POST /v1/messages/count_tokens",
      "messages.batches": "* /v1/messages/batches",
      "beta.messages.create": "POST /v1/messages",
      "beta.messages.stream": "POST /v1/messages",
      "beta.messages.parse": "POST /v1/messages",
      "completions.create": "POST /v1/complete",
      "models.list": "GET /v1/models",
      "models.retrieve": "GET /v1/models",
    },
  },
  {
    id: "google",
    clientClasses: ["GoogleGenAI", "GoogleGenerativeAI", "VertexAI", "Client", "GenerativeModel"],
    packages: {
      ts: ["@google/genai", "@google/generative-ai", "@google-cloud/vertexai"],
      js: ["@google/genai", "@google/generative-ai", "@google-cloud/vertexai"],
      // Python import names (google.genai, google.generativeai, vertexai) are handled in the Python scanner
      py: ["google-genai", "google-generativeai", "google-cloud-aiplatform", "vertexai"],
      java: ["com.google.genai:google-genai"],
      go: ["google.golang.org/genai", "github.com/google/generative-ai-go"],
    },
    hosts: ["generativelanguage.googleapis.com", "aiplatform.googleapis.com"],
    versionHeaders: [],
    modelPattern:
      /^(models\/|publishers\/google\/models\/)?(gemini-[\w.-]+|gemma-[\w.-]+|imagen-[\w.-]+|imagegeneration@\d+|veo-[\w.-]+|text-embedding-00\d|text-multilingual-embedding-00\d|textembedding-gecko[\w@-]*|text-bison[\w@-]*|chat-bison[\w@-]*|code-gecko[\w@-]*)$/,
    sdkOps: {
      "models.generateContent": "POST /v1beta/models/{model}:generateContent",
      "models.generateContentStream": "POST /v1beta/models/{model}:streamGenerateContent",
      "models.generate_content": "POST /v1beta/models/{model}:generateContent",
      "models.generate_content_stream": "POST /v1beta/models/{model}:streamGenerateContent",
      "models.embedContent": "POST /v1beta/models/{model}:embedContent",
      "models.embed_content": "POST /v1beta/models/{model}:embedContent",
      "models.generateImages": "POST /v1beta/models/{model}:predict",
      "models.generate_images": "POST /v1beta/models/{model}:predict",
      "models.generateVideos": "POST /v1beta/models/{model}:predictLongRunning",
      "models.generate_videos": "POST /v1beta/models/{model}:predictLongRunning",
      "aio.models.generate_content": "POST /v1beta/models/{model}:generateContent",
      "chats.create": "POST /v1beta/models/{model}:generateContent",
      "getGenerativeModel": "POST /v1beta/models/{model}:generateContent",
    },
  },
  {
    id: "stripe",
    clientClasses: ["Stripe", "StripeClient"],
    packages: { ts: ["stripe"], js: ["stripe"], py: ["stripe"], java: ["com.stripe:stripe-java"], go: ["github.com/stripe/stripe-go"], rb: ["stripe"], php: ["stripe/stripe-php"], cs: ["Stripe.net"] },
    hosts: ["api.stripe.com"],
    // Local helpers and the SDK's own setup (\Stripe\Stripe::setApiKey, Stripe::StripeClient.new, StripeConfiguration)
    localOps: /^(webhooks|errors|Webhook|Error|StripeError|Stripe|StripeClient|StripeConfiguration|Util|util)\./i,
    versionHeaders: ["stripe-version"],
    versionKeys: ["apiVersion", "api_version", "stripe_version"],
    versionSetters: [
      // Ruby / Python: Stripe.api_version = '…'; PHP: \Stripe\Stripe::setApiVersion('…'); Java: setStripeVersionOverride("…")
      { re: /\bstripe\.api_version\s*=\s*["'](\d{4}-\d{2}-\d{2}(?:\.\w+)?)["']/i },
      { re: /\bsetApiVersion\(\s*["'](\d{4}-\d{2}-\d{2}(?:\.\w+)?)["']/, needs: /stripe/i },
      { re: /\bsetStripeVersionOverride\(\s*"(\d{4}-\d{2}-\d{2}(?:\.\w+)?)"/ },
      // C#: new RequestOptions { StripeVersion = "…" }; Python: StripeClient(…, stripe_version="…")
      { re: /\bStripeVersion\s*=\s*"(\d{4}-\d{2}-\d{2}(?:\.\w+)?)"/ },
      { re: /\bstripe_version\s*[=:]\s*["'](\d{4}-\d{2}-\d{2}(?:\.\w+)?)["']/ },
    ],
    modelPattern: NEVER,
    sdkOps: {},
    opFor: stripeOp,
  },
  {
    id: "twilio",
    clientClasses: ["Twilio", "Client"],
    packages: { ts: ["twilio"], js: ["twilio"], py: ["twilio"], java: ["com.twilio.sdk:twilio"], go: ["github.com/twilio/twilio-go"], rb: ["twilio-ruby"], php: ["twilio/sdk"], cs: ["Twilio"] },
    hosts: ["api.twilio.com", "messaging.twilio.com", "verify.twilio.com", "conversations.twilio.com", "voice.twilio.com"],
    versionHeaders: [],
    modelPattern: NEVER,
    sdkOps: {},
    opFor: twilioOp,
  },
  {
    id: "github",
    clientClasses: ["Octokit", "App"],
    packages: { ts: ["@octokit/rest", "octokit", "@octokit/core"], js: ["@octokit/rest", "octokit", "@octokit/core"], go: ["github.com/google/go-github"], rb: ["octokit"], cs: ["Octokit"] },
    hosts: ["api.github.com"],
    versionHeaders: ["x-github-api-version"],
    modelPattern: NEVER,
    // Generated from GitHub's published OpenAPI spec (scripts/build-github-ops.ts)
    sdkOps: GITHUB_OPS,
    stripPrefix: /^rest\./,
  },
  {
    id: "shopify",
    clientClasses: ["shopifyApi", "createAdminApiClient", "Shopify", "Session"],
    packages: { ts: ["@shopify/shopify-api", "@shopify/admin-api-client", "shopify-api-node"], js: ["@shopify/shopify-api", "@shopify/admin-api-client", "shopify-api-node"], py: ["ShopifyAPI"], rb: ["shopify_api"], php: ["shopify/shopify-api"] },
    hosts: ["myshopify.com"],
    versionHeaders: ["x-shopify-api-version"],
    versionKeys: ["apiVersion", "api_version"],
    // Python: shopify.Session(shop_url, '2024-10', token): the version is the second positional argument
    versionSetters: [
      { re: /\bSession\(\s*[^,()]+,\s*["'](\d{4}-\d{2})["']/, needs: /shopify/i },
      // v13: the SDK enum's names (ApiVersion.July25 → 2025-07), wherever they're used (codegen configs too)
      { re: /\bApiVersion\.(January|April|July|October)(\d{2})\b/, fmt: (m) => `20${m[2]}-${({ January: "01", April: "04", July: "07", October: "10" } as Record<string, string>)[m[1]]}`, needs: /shopify/i },
    ],
    urlVersion: /\/admin\/api\/(\d{4}-\d{2})\//,
    urlVersionStandsAlone: true,
    // v14: the Storefront API (https://{shop}.myshopify.com/api/2025-01/graphql.json) shares the Admin API's versions
    hostUrlVersion: /myshopify\.com\/api\/(\d{4}-\d{2})\//,
    versionToken: /^\d{4}-(01|04|07|10)$/,
    versionEvidence: /myshopify|shopify|storefront|customer[-_ ]?account/i,
    // The Partner API has its own versions and no record yet: not the Admin API's
    notEvidence: /partner/i,
    versionConst: shopifyVersionConst,
    modelPattern: NEVER,
    sdkOps: {},
  },
  {
    id: "meta",
    clientClasses: [],
    // The Business SDKs belong to the Marketing API (providers/meta-marketing.json), whose versions expire sooner
    packages: { rb: ["koala"] },
    hosts: ["graph.facebook.com", "graph.instagram.com"],
    // v14: libraries whose files carry no Graph host (fbgraph's setVersion, whatsapp-api-js, messaging-api-messenger)
    keywords: ["fbgraph", "WhatsAppAPI", "MessengerClient", "passport-facebook", "FacebookProvider", "import facebook\\b", "from facebook import", "facebook_business", "facebook-nodejs-business-sdk", "FacebookAdsApi", "GraphAPI\\("],
    // www.facebook.com/vNN.N/dialog/oauth: the login dialog follows Graph's versions; the site's other pages aren't the API
    versionOnlyHosts: ["www.facebook.com", "facebook.com", "m.facebook.com"],
    versionHeaders: [],
    versionKeys: ["api_version", "apiVersion", "version"],
    urlVersion: /\/(v\d+\.\d+)\//,
    // v15: two-digit minors too (v2.10, v2.11, v2.12 are Graph versions)
    versionToken: /^v\d{1,2}\.\d{1,2}$/,
    // v12: env-var prefixes apps use for Meta settings (WA_BUSINESS_VERSION, FB_GRAPH_VERSION, IG_API_VERSION, GRAPH_API_VERSION)
    // A bare GRAPH_API_VERSION isn't evidence: Microsoft Graph uses the same name
    versionEvidence: /graph\.facebook\.com|graph\.instagram\.com|facebook|instagram|whatsapp|messenger|\bFB\.init\b|fbAsyncInit|\bkoala\b|restfb|\b(?:WA|FB|IG|WABA|META)_\w*VERSION/i,
    // Threads; and Microsoft Graph (its host, SDKs, Outlook, and its signature version pair 'v1.0' + 'beta')
    notEvidence: /threads|graph\.microsoft\.com|msgraph|microsoft[-_ ]?graph|outlook|office365|\bazure\b|["'`]beta["'`]/i,
    versionSetters: [
      // Python facebook-sdk: GraphAPI(access_token, version='3.1'); restfb: Version.VERSION_19_0; Koala.config.api_version = '…'
      { re: /\bGraphAPI\([^)]*\bversion\s*=\s*["'](\d+\.\d+)["']/, fmt: (m) => `v${m[1]}`, needs: /facebook/i },
      // v15: the same with the version in a name (GraphAPI(token, version=GRAPH_API_VERSION))
      { re: /\bGraphAPI\([^)]*\bversion\s*=\s*([A-Za-z_][\w.]*)\s*[,)]/, ident: true, needs: /facebook/i },
      { re: /\bVersion\.VERSION_(\d+)_(\d+)\b/, fmt: (m) => `v${m[1]}.${m[2]}`, needs: /restfb/ },
      { re: /\bKoala\.config\.api_version\s*=\s*["'](v\d+\.\d+)["']/ },
      // v14: fbgraph's graph.setVersion('7.0')
      { re: /\b[A-Za-z_$][\w$]*\.setVersion\(\s*["']v?(\d+\.\d+)["']/, fmt: (m) => `v${m[1]}`, needs: /fbgraph/ },
      // v12: library options that set the version (whatsapp-api-js { v }, messaging-api-messenger { version })
      { re: /\bnew\s+WhatsAppAPI\s*\(\s*\{[^}]*\bv\s*:\s*["'`](v\d+\.\d+)["'`]/ },
      // v14: the same options set from a constant (v: WA_VERSION): resolved through the name's binding
      { re: /\bnew\s+WhatsAppAPI\s*\(\s*\{[^}]*\bv\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*[,}]/, ident: true },
      { re: /\bMessengerClient(?:\.connect)?\s*\(\s*\{[^}]*\bversion\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*[,}]/, ident: true },
      // the JS SDK: FB.init({ version: Constants.META_GRAPH_VERSION }), the name resolved through its import like any constant
      { re: /\bFB\.init\s*\(\s*\{[^}]*\bversion\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*[,}]/, ident: true },
      { re: /\bMessengerClient(?:\.connect)?\s*\(\s*\{[^}]*\bversion\s*:\s*["'`]v?(\d+\.\d+)["'`]/, fmt: (m) => `v${m[1]}` },
    ],
    modelPattern: NEVER,
    sdkOps: {},
  },
];

// ---------- provider plugins: one JSON file per provider ----------

/**
 * A provider described as data. Built-in ones live in src/providers/*.json; companies add their own (internal APIs)
 * in .vitasta.yml. Anything that needs code (a naming rule, a version constant format) is referenced by name.
 */
export interface ProviderSpec {
  id: string;
  hosts: string[];
  packages?: Partial<Record<Lang, string[]>>;
  clientClasses?: string[];
  versionHeaders?: string[];
  versionKeys?: string[];
  /** Regex source for this provider's model IDs */
  modelPattern?: string;
  /** SDK call path → "METHOD /path" */
  sdkOps?: Record<string, string>;
  /** Named rule for SDK call paths without a table entry */
  opRule?: keyof typeof OP_RULES;
  /**
   * Template for SDK call paths without a table entry, for APIs whose methods map 1:1 to URLs, e.g. Slack
   * "POST /api/{call}" turns client.chat.postMessage (or Python chat_postMessage) into POST /api/chat.postMessage
   */
  opTemplate?: string;
  stripPrefix?: string;
  /** Regex source with one capture group for the version in a URL, e.g. "/api/v(\\d+)/" */
  urlVersion?: string;
  /** v13: regex sources for versions outside a full URL (see ProviderDef.versionToken / versionEvidence / notEvidence) */
  versionToken?: string;
  versionEvidence?: string;
  notEvidence?: string;
  versionConstRule?: keyof typeof VERSION_CONST_RULES;
  keywords?: string[];
  /** Regex source; see ProviderDef.pathPattern (built-in providers only) */
  pathPattern?: string;
  /** See ProviderDef.versionFallback */
  versionFallback?: string;
  /** Regex source; see ProviderDef.publicModelPattern (built-in providers only) */
  publicModelPattern?: string;
}

const OP_RULES = { "stripe-resources": stripeOp, "twilio-shorthand": twilioOp } as const;
const VERSION_CONST_RULES = { "shopify-apiversion-enum": shopifyVersionConst } as const;

function templateOp(template: string): (callPath: string) => string | undefined {
  if (!/^(GET|POST|PUT|PATCH|DELETE|\*) \/\S*\{call\}/.test(template)) throw new Error(`opTemplate must look like "POST /api/{call}": "${template}"`);
  return (callPath) => (/^[A-Za-z][\w.]*$/.test(callPath) ? template.replace("{call}", callPath.replace(/_/g, ".")) : undefined);
}

/** The provider whose API lives on this host (for clients pointed at a compatible endpoint, e.g. OpenAI SDK → Groq) */
export function providerOfHost(host: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => !p.pathPattern && p.hosts.some((h) => host === h || host.endsWith("." + h)));
}

export function providerFromSpec(spec: ProviderSpec): ProviderDef {
  if (!spec.id || !/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) throw new Error(`provider id must be lowercase letters, digits and dashes: "${spec.id}"`);
  if (!spec.hosts?.length) throw new Error(`provider ${spec.id}: at least one host is required`);
  return {
    id: spec.id,
    hosts: spec.hosts,
    packages: spec.packages ?? {},
    clientClasses: spec.clientClasses ?? [],
    versionHeaders: (spec.versionHeaders ?? []).map((h) => h.toLowerCase()),
    versionKeys: spec.versionKeys,
    modelPattern: spec.modelPattern ? new RegExp(spec.modelPattern) : NEVER,
    sdkOps: spec.sdkOps ?? {},
    opFor: spec.opRule ? OP_RULES[spec.opRule] : spec.opTemplate ? templateOp(spec.opTemplate) : undefined,
    stripPrefix: spec.stripPrefix ? new RegExp(spec.stripPrefix) : undefined,
    urlVersion: spec.urlVersion ? new RegExp(spec.urlVersion) : undefined,
    versionToken: spec.versionToken ? new RegExp(spec.versionToken) : undefined,
    versionEvidence: spec.versionEvidence ? new RegExp(spec.versionEvidence, "i") : undefined,
    notEvidence: spec.notEvidence ? new RegExp(spec.notEvidence, "i") : undefined,
    versionConst: spec.versionConstRule ? VERSION_CONST_RULES[spec.versionConstRule] : undefined,
    keywords: spec.keywords,
    pathPattern: spec.pathPattern ? new RegExp(spec.pathPattern) : undefined,
    versionFallback: spec.versionFallback,
    publicModelPattern: spec.publicModelPattern ? new RegExp(spec.publicModelPattern) : undefined,
  };
}

/** Add or replace a provider (built-in JSON plugins at startup, a repo's custom providers from .vitasta.yml). */
export function registerProvider(def: ProviderDef): void {
  const i = PROVIDERS.findIndex((p) => p.id === def.id);
  if (i >= 0) PROVIDERS[i] = def;
  else PROVIDERS.push(def);
  providersVersion++;
}

/** Bumped whenever the registry changes, so caches built from it (the scan prefilter) know to rebuild. */
export let providersVersion = 0;

let scanLock: Promise<unknown> = Promise.resolve();

/**
 * Run fn with extra providers (a repo's custom APIs) registered, then restore the registry exactly as it was,
 * so one repo's providers never leak into another repo's scan on a shared server.
 */
export async function withProviders<T>(extra: ProviderDef[], fn: () => Promise<T>): Promise<T> {
  // The registry is shared, so scans take turns: a scan running at the same time as another repo's would otherwise
  // see (and could keep) that repo's providers
  const run = async () => {
    const saved = [...PROVIDERS];
    for (const d of extra) registerProvider(d);
    try {
      return await fn();
    } finally {
      PROVIDERS.splice(0, PROVIDERS.length, ...saved);
      providersVersion++;
    }
  };
  const result = scanLock.then(run, run);
  scanLock = result.catch(() => undefined);
  return result;
}

/** Load every built-in provider plugin in src/providers/*.json */
function loadBuiltInSpecs(): void {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "providers");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    registerProvider(providerFromSpec(JSON.parse(readFileSync(join(dir, f), "utf8")) as ProviderSpec));
  }
}
loadBuiltInSpecs();


type Host = "azure" | "bedrock" | "vertex";

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BEDROCK_NS = new Map(Object.entries(PARTNERS.bedrock.namespaces));
const BEDROCK_ARN = /^arn:aws[\w-]*:bedrock:[\w-]*:\d*:[\w-]+\//;
/** A cross-region prefix in front of a known namespace: us.anthropic.…, eu.meta.…, global.amazon.… */
const BEDROCK_REGION = new RegExp(`^[a-z-]+\\d?\\.(?=(?:${[...BEDROCK_NS.keys()].map(esc).join("|")})\\.)`);
const AZURE_FAMILIES = PARTNERS.azure.families.map((f) => ({ provider: f.provider, pattern: new RegExp(f.pattern, "i") }));

/** Provider ids that partner-models.json names for a platform (so the platform's code may serve them) */
export function partnerProviders(host: Host): string[] {
  return host === "bedrock" ? [...new Set(BEDROCK_NS.values())] : host === "azure" ? [...new Set(AZURE_FAMILIES.map((f) => f.provider))] : [];
}

/**
 * A Bedrock model ID of a vendor in partner-models.json: <namespace>.<model>, after an ARN or a cross-region prefix.
 * Strong when nothing else writes it like that: an ARN, a region prefix, or Bedrock's version ending (-v1:0, :0).
 */
export function bedrockModel(raw: string): { provider: string; model: string; strong: boolean } | undefined {
  const arn = BEDROCK_ARN.test(raw);
  let m = raw.replace(BEDROCK_ARN, "");
  const region = BEDROCK_REGION.test(m);
  m = m.replace(BEDROCK_REGION, "");
  const x = /^([a-z0-9]+)\.([a-z0-9][\w.:-]*)$/.exec(m);
  const provider = x ? BEDROCK_NS.get(x[1]) : undefined;
  if (!x || !provider || !/[\d-]/.test(x[2]) || x[2].length > 120) return undefined;
  return { provider, model: m, strong: arn || region || /-v\d+(:\d+)?$|:\d+$/.test(x[2]) };
}

/** The vendor of a model name in Azure's catalog (partner-models.json families), if it is one */
export function azureFamily(model: string): string | undefined {
  return model.length <= 120 ? AZURE_FAMILIES.find((f) => f.pattern.test(model))?.provider : undefined;
}

/**
 * The platform a model must run on to count, when only partner-models.json knows it (no provider's own pattern):
 * a Bedrock-form ID only on Bedrock, an Azure catalog name only on Azure.
 */
export function partnerOnlyHost(model: string): Host | undefined {
  const m = normalizeModel(model);
  if (PROVIDERS.some((p) => p.modelPattern.test(m))) return undefined;
  if (bedrockModel(m)) return "bedrock";
  if (azureFamily(m)) return "azure";
  return undefined;
}

/** Some model IDs say where they run: Bedrock IDs and ARNs, Vertex "@version" IDs and publisher paths. */
export function hostOfModel(model: string): Host | undefined {
  if (/^arn:aws[\w-]*:bedrock:|(^|\.)anthropic\.claude-/.test(model) || bedrockModel(model)?.strong) return "bedrock";
  if (/^claude-[\w.-]+@\d{8}$/.test(model) || model.startsWith("publishers/")) return "vertex";
  return undefined;
}

/** Bedrock: strip the ARN and the cross-region prefix, e.g. us.meta.llama-x-v1:0 → meta.llama-x-v1:0.
 *  Google: strip "models/" and "publishers/google/models/". */
export function normalizeModel(model: string): string {
  let m = model.replace(BEDROCK_ARN, "");
  m = m.replace(BEDROCK_REGION, "");
  m = m.replace(/^(publishers\/[\w-]+\/)?models\//, "");
  return m;
}

/** Partner vendors without an API of their own here get a provider entry, so their models have a provider id */
function loadPartnerProviders(): void {
  const ids = [...BEDROCK_NS.values(), ...AZURE_FAMILIES.map((f) => f.provider)];
  for (const id of new Set(ids)) {
    if (PROVIDERS.some((p) => p.id === id)) continue;
    PROVIDERS.push({ id, clientClasses: [], packages: {}, hosts: [], versionHeaders: [], modelPattern: NEVER, sdkOps: {} });
  }
}
loadPartnerProviders();

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** v10: an AI provider (it has model IDs): its calls and params belong to the AI module */
export function isAiProvider(id: string): boolean {
  const p = providerById(id);
  return !!p && p.modelPattern.source !== NEVER.source;
}

/** Map an SDK call path to an HTTP operation: table (longest prefix wins), then the provider's naming rule. */
export function sdkOp(provider: ProviderDef, callPath: string): string | undefined {
  const path = provider.stripPrefix ? callPath.replace(provider.stripPrefix, "") : callPath;
  // v9: helpers the SDK runs locally (Stripe's webhooks.constructEvent) aren't API operations
  if (provider.localOps?.test(path)) return undefined;
  if (Object.prototype.hasOwnProperty.call(provider.sdkOps, path)) return provider.sdkOps[path];
  let best: string | undefined;
  for (const key of Object.keys(provider.sdkOps)) {
    if (path.startsWith(key + ".")) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? provider.sdkOps[best] : provider.opFor?.(path);
}

/**
 * v9: for a receiver merely named after a naming-rule provider (`$this->stripe->…`, `stripe.…` from another module),
 * the call must look like the SDK's: resource names without underscores and an operation verb
 */
const SDK_VERB = /^(create|retrieve|update|del|delete|list|all|search|cancel|confirm|capture|attach|detach|expire|finalize\w*|pay|void\w*|send\w*|mark\w*|verify\w*|apply\w*|approve|reject|resume|pause|close|reopen|refund|reverse|createReversal|list\w+|retrieve\w+|create\w+|update\w+|delete\w+|del\w+|auto_paging_iter|listAutoPaging)$/;
export function looksLikeSdkPath(callPath: string): boolean {
  const parts = callPath.split(".");
  const verb = parts.pop()!;
  return parts.length >= 1 && parts.every((p) => /^[A-Za-z][A-Za-z0-9]*$/.test(p)) && SDK_VERB.test(verb);
}

/** Version pinned in a request URL, e.g. Shopify /admin/api/2025-07/ or Meta /v21.0/ */
export function urlVersionOf(provider: ProviderDef, url: string): string | undefined {
  return provider.urlVersion?.exec(url)?.[1]
    ?? (provider.hostUrlVersion && provider.hosts.some((h) => url.includes(h)) ? provider.hostUrlVersion.exec(url)?.[1] : undefined);
}

/** Which provider's API does this URL point at, and what is the path? */
export function matchUrl(url: string): { provider: ProviderDef; path: string } | undefined {
  // Providers that own only part of a shared host go first
  for (const p of [...PROVIDERS.filter((x) => x.pathPattern), ...PROVIDERS.filter((x) => !x.pathPattern)]) {
    for (const host of p.hosts) {
      const i = url.indexOf(host);
      if (i >= 0) {
        // "{?}" marks an unknown part of the URL; don't let its "?" be taken as the start of a query string
        const rest = url.slice(i + host.length).replace(/\{\?\}/g, "{id}");
        const path = rest.startsWith("/") ? rest.split(/[?#]/)[0] : "/";
        if (p.pathPattern && !p.pathPattern.test(path)) continue;
        return { provider: p, path };
      }
    }
  }
  return undefined;
}

/** Client classes that talk to a cloud host instead of the provider's own API. */
export function hostOfClass(cls: string): Host | undefined {
  if (/Azure/.test(cls)) return "azure";
  if (/Bedrock/.test(cls)) return "bedrock";
  if (/Vertex/i.test(cls)) return "vertex";
  return undefined;
}

export function modelProvider(model: string): ProviderDef | undefined {
  const own = PROVIDERS.find((p) => p.modelPattern.test(model));
  if (own) return own;
  // A partner vendor's model on a cloud platform (partner-models.json); counted only on that platform (index.ts)
  const partner = bedrockModel(model)?.provider ?? azureFamily(model);
  return partner ? providerById(partner) : undefined;
}

/**
 * Provider prefixes that frameworks (LiteLLM, pydantic-ai, Upsonic, Agno, …) put in front of a model ID to say where
 * to send it: "anthropic/claude-x", "anthropic:claude-x", "bedrock/anthropic.claude-…", "vertex_ai/claude-…@…".
 * The prefix names the API (and so whose retirement dates apply), not a model of its own.
 */
const ROUTE_PREFIXES: Record<string, Host | null> = {
  anthropic: null, openai: null, gemini: null, google: null, "google-gla": null, mistral: null, mistralai: null,
  groq: null, cohere: null, deepseek: null, xai: null,
  bedrock: "bedrock", "bedrock-converse": "bedrock", vertex_ai: "vertex", "vertex-ai": "vertex", "google-vertex": "vertex", azure: "azure", azure_ai: "azure",
};

/**
 * Does this file talk to a router (OpenRouter, Together: providers whose own IDs look like "openai/gpt-4o")? Then a
 * prefixed ID is that router's model, with the router's dates, not a route to the provider's own API.
 */
export function mentionsRouter(source: string): boolean {
  return PROVIDERS.some(
    (p) =>
      p.publicModelPattern &&
      (p.hosts.some((h) => h && source.includes(h)) ||
        // A package named in an import or require ("@openrouter/sdk", import openrouter), not a word in a comment
        Object.values(p.packages).flat().some((w) => !!w && ([`"${w}"`, `'${w}'`, `"${w}/`, `'${w}/`].some((q) => source.includes(q)) || new RegExp(`^[ \\t]*(?:from|import)\\s+${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m").test(source)))),
  );
}

/** A model ID as written in code, with any route prefix taken off: which provider, which model, which host. */
export function modelRef(raw: string, routerFile = false): { provider: ProviderDef; model: string; host?: Host; prefixed: boolean } | undefined {
  // a config placeholder's default (Spring "${llm.model:gpt-4o}", application.yml ${LLM_MODEL:gpt-4.1}, ${VAR:-x}) is
  // the model the app uses when nothing sets the key
  const ph = /^\$\{[\w.\-\[\]]+:-?([^{}$]+)\}$/.exec(raw.trim());
  if (ph) return modelRef(ph[1].trim(), routerFile);
  const direct = modelProvider(raw);
  if (direct) return { provider: direct, model: raw, prefixed: false };
  if (routerFile) return undefined;
  // A gateway in front of the route: "mastra/openai/gpt-5-mini", "gateway/anthropic:claude-…" (one or two plain
  // segments, never a file path: the model part can't end in a file extension)
  const gw = /^(?:[a-z][\w-]{0,30}\/){1,2}([a-z][\w-]*[/:].+)$/.exec(raw);
  if (gw && !/\.(md|mdx|json|ya?ml|txt|ts|js|py|png|jpg|svg|html|csv)$/i.test(raw)) {
    const inner: ReturnType<typeof modelRef> = modelRef(gw[1], routerFile);
    if (inner?.prefixed) return inner;
  }
  const m = /^([a-z][\w-]*)[/:](.+)$/.exec(raw);
  if (!m || !(m[1] in ROUTE_PREFIXES)) return undefined;
  const p = modelProvider(m[2]);
  if (!p) return undefined;
  const host = ROUTE_PREFIXES[m[1]] ?? hostOfModel(m[2]);
  return { provider: p, model: m[2], ...(host ? { host } : {}), prefixed: true };
}

/**
 * Names of AI model vendors the scanner knows: its own providers and the partner vendors on Bedrock and Azure
 * (src/data/partner-models.json), lowercased. Used to tell one vendor's code from another's (src/scan/vendors.ts).
 */
export function vendorNames(): Set<string> {
  const out = new Set<string>(PROVIDERS.filter((p) => isAiProvider(p.id)).map((p) => p.id));
  for (const [k, v] of Object.entries(PARTNERS.bedrock.namespaces)) { out.add(k.toLowerCase()); out.add(v.toLowerCase()); }
  for (const f of PARTNERS.azure.families) out.add(f.provider.toLowerCase());
  return out;
}
