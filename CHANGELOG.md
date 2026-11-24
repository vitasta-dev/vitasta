# Changelog

## 0.2.0 (25 Nov 2026)

**Every place the retired thing exists is reported, in two tiers.**
- **Action needed:** live request sites and defaults. Only these can fail a check.
- **Also in your code:** model catalogs and tables, dead or unused code, a request whose provider the call site doesn't
  show, and documentation. It is collapsed and grouped per file, and never fails. A large catalog is one line per file
  listing the retired ids, and each id keeps its own record in the JSON.
- Each finding says why it's in the "also" tier: `usage.context` (`catalog`, `dead`, `unused`,
  `provider-unresolved`) with `usage.contextReason`, and `usage.tier` (`action` or `also`).
- Tests stay out by default ("Also in tests"). `test-data/`, `test_data/`, `__data__/` and `test-fixtures/` folders
  count as tests.
- The PR check summary has "Action needed in this pull request" and a collapsed "Also in this pull request" section;
  the second never fails the check. The app's tracking issue and check run use the same tiers (app c564e82).

**Dead code.** A provider call inside a function, method or class nothing in the repo refers to is marked dead (also
tier, one confidence step lower):
- code after a top-level exit;
- in Go, exported functions, methods and types nothing refers to, in an app (package main or internal/);
- classes loaded by convention (names built from strings, importlib, entry points) stay live.

**New provider: Azure OpenAI.** Azure-hosted OpenAI endpoints are their own provider: openai.azure.com,
cognitiveservices.azure.com and services.ai.azure.com under /openai/. This covers the Azure paths, api-version pins,
the Azure SDKs and Realtime URLs.

**Recall, from test sets (each fix a generic rule, tested on hand-written code):**
- **Anthropic request bodies:**
  - a function that sends the request sends what it sets, whatever its signature names or wherever the value comes
    from;
  - a value declared, returned or cast as `Anthropic.MessageCreateParams` (and its NonStreaming, Stream and Beta forms)
    is a request body wherever it is;
  - a builder passed as a callback to the method that sends its result builds that request;
  - setting-name tables copied into the body by a loop are reported at their entries;
  - Python methods forwarding `**kwargs` to a provider call are wrappers, so their callers' keyword arguments are the
    request's.
- **Go:** request structs (reported where the sending function sets the field), map-literal bodies, settings defaults
  from struct tags and viper, and text/template, Sprig and Helm bodies.
- **All languages:**
  - form bodies (URLSearchParams, `data=`, `url.Values`, FormUrlEncodedContent, …), including bracket-indexed keys;
  - models in URL paths (Gemini, Vertex publishers, Bedrock invoke);
  - SQL seed rows that code reads into a request.
- **Meta:**
  - versions from Spring config through entity fields;
  - `FB.init` version constants through imports;
  - Graph bases joined to Marketing endpoints are Marketing;
  - Marketing versions with no record of their own fall back to the same Graph version's sunset.
- **OpenAI:**
  - request tables of `{Method, Endpoint}` rows;
  - Go Terraform-style `APIURL` joins;
  - `audio.translations.create`;
  - Markdown and TOML agent files naming an endpoint (documentation, also tier).
- **Google Ads:**
  - API versions in SDK import paths and namespaces (PHP, Python, Java, C#, Ruby);
  - the default versions of npm google-ads-api and google-ads-node, and PyPI google-ads, read from their published
    releases.
- **MS Graph:** drive alias paths (`/me/drive`, `/users/{id}/drive`, …) and relative paths joined to a base held in a
  name.
- **Library behaviour by installed release:** Spring AI Anthropic sampling (2.1.0 drops it), Microsoft.Extensions.AI
  ChatOptions through the Anthropic adapter, Mastra model settings, the golang.org/x/oauth2 Facebook endpoint default,
  and facebook-messenger's Graph version per release.

**Precision:**
- served routes, router links, path tests and CSS attribute selectors aren't calls;
- option setters that only store a value aren't defaults;
- a declaration (a type, an interface member, a signature) isn't a value;
- another object's same-named method, a sibling script's flag or a same-named Go type in another package doesn't
  join a value to a request;
- a provider SDK copied into the repo gives one note;
- UI values and widget names aren't requests;
- clients pointed at another server (a gateway, localhost) never fail a check;
- capability-gated settings are possible and never fail;
- OpenAI type names (`ChatCompletion…`) match only as written, so a `chatCompletion()` method isn't OpenAI's.

**Speed.** Quadratic regex paths on long lines were removed, and a per-file cost guard was added.

**Trial, off by default:** automatic library maps (`VITASTA_LIBMAP_DIR`).

**Also since 0.1.5 (19–23 Nov):**

**API-meaning headers follow the request's operation, and one finding per endpoint class.**
- An `OpenAI-Beta: assistants=…` header on a request whose URL the value tracer resolves (header mode: the url /
  endpoint names in the header's function, traced through parameters to their call-site constants) matches the
  Assistants record only when one of those operations is an Assistants/Threads path. When none can be found it
  still matches.
- A call of `Class.Method`, where the repo defines `Class` and `Class`'s file already has a finding for the same
  change (a library wrapping its own endpoint), isn't another finding.
- Control statements (`switch`, `if`, …) are no longer taken for function declarations by the tracer.

**Python: provider from configuration ("possible").** `init_chat_model(model_provider=<a name>, …)` in a repo that
depends on langchain-anthropic, and `init_chat_model(model_provider="openai", model=provider + "/" + model, base_url=…)`
(a provider-prefixed id through an OpenAI-compatible proxy) in a repo that names Anthropic, are possible Anthropic
Messages calls. There is one finding per sampling keyword. The skipped Python files that call `init_chat_model` are
read for this pass. The value tracer now runs for every repo, Python ones included, and a field read on a receiver of
unknown type only follows assignments to that same name in the same file.

**One value tracer for every language (item 4/F; `src/scan/flow.ts` + per-language syntax in `flowlang.ts`).** It
replaces the Go-only tracer and runs in Go, Java/Kotlin, C#, TypeScript/JavaScript, PHP and Python, in two modes:
- From each request setting found (setting mode): where its value comes from.
- From each provider URL built from names (value mode): the names are evaluated to literals, and a versioned provider
  URL gives a version pin.

It steps through:
- fields (initializers, constructor and `this.x =` assignments, object literals and initializers, builder and setter
  calls);
- getters (explicit, or implicit for Lombok, records and properties);
- constants and enums, records built from a literal, and accessors on named constants;
- local functions' returns, function literals, and the sides of `?:` / `??` / `or`;
- config reads (the declared key's `.defaultValue(…)` and the call's own default), parameter defaults, and pflag,
  argparse, `@Value`/`@Option` defaults;
- locals, and parameters to their call-site arguments.

Reported: the lines that hold the value (a literal, default or constant), the lines that feed a setting directly,
and the lines that choose a version by a named constant. The lines in between are alsoLines. Test files are never
sources. Each trace is bounded by twelve hops and a work budget, and steps are memoised across traces. Searches are
plain-text plus hand-checked context, so long files don't backtrack.

**Go: where an SDK setting's value comes from (item 4/F extension).** From each SDK params setting the vocabulary rule
finds, the value is traced back through the repo, up to eight hops, and each source line is reported as the same
op and wire name. The tracer follows:
- repo struct fields to their composite literals and `v.F =` assignments, with receivers, parameters, locals and
  closure parameters typed;
- getters to what they return;
- function parameters to the arguments at their call sites (functional options like `WithTemperature(0.2)`);
- func literals to their `return` values;
- locals and package-level consts/vars to their declarations;
- names bound to a cobra/pflag flag to the flag's default.

Every non-test Go file is read for this pass.

**Client recognition, layer 2 (PHP).** PHP vocabulary comes from Packagist releases: Packagist's metadata names a
repository and an exact commit, and only that commit is shallow-fetched; git checks every object against its hash.
The check is recorded as "git sha <ref> via packagist". Packages:
- openai-php/client (3 releases), with the openai-php/laravel facade;
- anthropic-ai/sdk (4 releases; 1.0 removed temperature/top_k/top_p).

The generator reads:
- resource methods and typed properties;
- routes from `method:`/`path:` named arguments, or from request helpers whose verb comes from their own body;
- "makers": `OpenAI::client()`, `factory()->…->make()`;
- facade `@method static` lines;
- params from `#[Required/Optional('wire')]`.

A receiver holds a client when it's one of:
- a `$this->x` assigned from a maker or `new`;
- a typed or promoted constructor parameter or property;
- a method returning one, in the class, its parent or a trait;
- a local set from a maker;
- a static facade.

Calls follow the chain to the op. Array keys, or named arguments through the params type, are the wire names.

**Client recognition, layer 2 (Ruby): one-hop receiver resolution over the vocabulary.** Ruby vocabulary is generated
from RubyGems releases (sha256), with resources from constructor/memoized assignments, routes from
`method: :post, path:` or verb helpers, params from `optional`/`required` declarations, and constant aliases followed:
- the official `openai` gem (4 releases);
- the official `anthropic` gem (5 releases; 2.0 removed temperature/top_k/top_p, as the other languages' SDKs did);
- ruby-openai (6 releases).

A name holds a client when a method or memoized ivar (`@client ||= Anthropic::Client.new`), an assigned ivar or a
constant (e.g. in an initializer) builds a vocabulary client, in the class, its parents or included modules. Calls on
it follow the resource chain to the op. Keyword args and `parameters: { … }` keys are the wire names. Java `.asc`
signatures are now checked too, and every vocabulary file records the integrity check per release.

**Client recognition, layer 4: call shapes from the vocabulary.** Where the receiver isn't known, a resource chain
plus method from the generated vocabulary, of at least two segments, counts as that SDK's call. Examples: C#
`.Messages.GetClaudeMessageAsync(`, Java `.messages().create(`, Go `.Chat.Completions.New(`. The longest chain at a
call wins. It counts only in a file that imports the SDK, is reported "possible", and isn't repeated where another
rule reports the same op within 3 lines.

**Client recognition, layer 1: SDK vocabulary generated from the SDKs (23 Nov design; "we shouldnt hardcode
much").** `src/data/sdk-vocab/*.json` is generated by `tools/vocab` from each SDK's published registry release, read
as data and never installed or run:
- Go: the module proxy zip, checked against sum.golang.org.
- C#: the NuGet package's compiled assembly, read with a small ECMA-335 metadata reader (`cil.py`). It never loads
  the assembly. Types, properties, method signatures, the string and UTF-8 literals each method body loads, call
  targets and `[JsonPropertyName]` attributes all come from the metadata.

For each SDK it records:
- client types and resource chains, with return types;
- methods, with the HTTP verb and route they send, mapped to the feed's op;
- params and options types, with each property's wire name (from the getter's literal, the serializer's
  `WritePropertyName` pairing, or JSON attributes).

The first rule using it: a value of a known params type (C# `new T { … }` / `T x` then `x.Prop = …`; Go `pkg.T{
Field: … }` / `x.Field = …`) sets request fields for the ops that take T, reported per setting at its line. When the
value is a local declared above, its line is an alsoLine. No receiver or client wiring is needed.

Java: Maven Central `-sources.jar` (checked against `.sha512`; Kotlin or Java). Routes come from `.method(HttpMethod.X)` +
`.addPathSegments(…)` in the function that takes the params type, and fields from `@JsonProperty`. The rule reads
`T.builder().field(…)…build()` chains, with T resolved through exact or wildcard imports. A setting another rule
already reports for the same call within a few lines isn't repeated.

Vocabulary so far:
- Anthropic (NuGet, 10 releases), Anthropic.SDK, OpenAI (NuGet);
- openai-go v3, anthropic-sdk-go, go-openai;
- anthropic-java (6 releases) and openai-java (6 releases; 4.81+ publish no .sha512, so 4.80.0 is the newest read).

The releases show where the SDKs dropped sampling settings with the API change: Anthropic NuGet 13.0 and
anthropic-java 3.0.

**Findings in test files are notes.** A place in a test file now has
role `note`, with `testRole` keeping test-asserts / test-data for what a fix does (`fixRoleFor`). The report lists
them under "Also in tests: notes", and the `--json` report puts them in `alsoInTests` instead of `findings`. They never
fail a check or count in the summary table. `includeTests` stays on. `isTestFile(rel, inTest)` gives the scanner's
test-file rule (test code and test settings, not examples) for scorers. The app's fix engine should read
`fixRoleFor` instead of `roleFor` when it takes this release: **ship together with app commit e42bf2c (local
branch `test-notes-fixrole`)**; without it the app would edit test data.

**Upstream library breaks: sampling settings through LangChain, ruby_llm and litellm.** A wrapper library's release
can send temperature / top_p / top_k (removed in Anthropic API version 2026-10-21) that the app never sets:
`@langchain/anthropic` 0.x sends temperature 1, top_k -1 and top_p -1 on every request (unless thinking is on), and
`ruby_llm` up to 1.6.2 sends temperature 0.7 for a Claude model. These are now reported where the app makes the
client, plus the lockfile or manifest line that pins the release, naming the first release that stops. Settings the
app sets through these libraries are read against the installed release: dropped for models it handles
(`langchain-anthropic` 1.7.1+ for claude-fable-5, 1.7.11+ also claude-mythos-5-2; `@langchain/anthropic` 1.4.1+ for
its prefixes, and with thinking on), litellm's client-side check (removed with `drop_params=True`, otherwise noted as
already failing), or a note when the model is picked at runtime. `litellm.completion(…, temperature=…)` and
`with_temperature(…)` are read as Anthropic requests for a Claude model. Data: `src/data/library-sampling.json`, built
from the feed's maps (every release of ruby_llm, 98 of litellm including each backported patch line, 31 of @langchain/anthropic and 20 of langchain-anthropic,
each with a seeded spot check).

**@ai-sdk/anthropic sampling ranges rebuilt from 117 releases read (majors 1–4).** 33 ranges in place of 20, each
with the releases read. The claude-3 / claude-2 / claude-instant rule (sampling sent) is now in every release that has
it (from 2.0.90, 3.0.101, 4.0.19); before, those ids fell through to the unknown-id rule and were taken as dropped.
A seeded spot check of 8 more releases, inside the ranges, matched every range.

**Precision: generated files and version lists.** Version pins in generated files (`*.generated.*`, `*.g.cs`,
`*.Designer.cs`, `*.pb.go`, `*_pb2.py`, or a header saying `<auto-generated>` / `@generated` / `Code generated … DO NOT
EDIT`) are dropped, like vendored code. A pin inside an enum that lists two or more versions of the provider is a
catalog of versions, not the one the app sends.

**A published library forwarding its callers' settings.** In a published package (package.json
with a name, not private, with main/exports/module), a provider request that spreads one of its function's parameters
(`client.messages.create({ model, ...options })`) sends what callers put there: when that parameter's declared type
(found through its import) lists a setting, the type's field is reported, "possible", in that library.

**Ruby: module constants named through their modules (item 4).** `#{Fb::Config::API_VERSION}` in a URL resolves to
the one binding of that name (Ruby resolves constants without imports), and so does a URL holder named that way
(`Fb::Config::GRAPH_URL`); a file's later uses of a version are lines of its one usage.

**Go: package-level versions reaching a URL in another file or package (item 4).** Package-level `const` / `var`
declarations (single and grouped) are read per folder; a reference is resolved in its own package or through an
import path and go.mod's module path. Expressions are evaluated across files: `"…" + X`, `pkg.Name`,
`fmt.Sprintf("…%s…", …)`.

**PHP: class constants, property defaults and config fallbacks reaching a URL (item 4).** Classes are indexed with
their parent, constants and property defaults, linked by namespace and `use`; `'…' . X` concatenations are evaluated
across files through `self::` / `static::` / `parent::` / `Class::CONST`, `$this->prop` (the class and its
ancestors), a local's last assignment in the function, and `config('key', DEFAULT)` / `env()` defaults.

**Java and C#: versions in constants, enums and defaults that reach a URL in another file.**
A per-file index of the values each Java/C# file defines (static final / const / static readonly fields, enum constants
and their arguments, aliases like `DEFAULT = V21`), linked by package or namespace and imports (exactly one type, or
none). Expressions are evaluated across files: string concatenation, C# interpolated strings, `Type.FIELD`,
`Enum.CONST.getValue()` / `.Value`, up to 3 levels; a URL's leading constant parts are enough. A line that references
such a value and makes a provider URL with a version is reported (one per file and version, other lines as alsoLines).

**Peak memory back near step 2's.** Most of the extra peak was garbage V8 hadn't collected yet: the scan now collects
between its passes and after each trace hop (V8's gc, enabled at run time; without it nothing changes). Traces don't
search other files for callers of a JS/TS function that isn't exported; indexes read on demand are kept without their
calls (the last 256 files' calls stay at hand); recently read text stays in a 48 MB cache. LibreChat: 771 MB to 527 MB,
same output.

**Settings on other lines, and Python clients made in another module.**
- A request's settings set on other lines of its function (a params dict filled before the call, an options object
  passed by name) are lines of the request (alsoLines), so a fix there is found.
- Python: a module-level SDK client made in another module (`client = StripeClient(…, stripe_version=…)` in
  pay/client.py, imported where it's used) is read like one made in the file, as TypeScript already did.

**SDK calls in Ruby, PHP, C#, Java and Go.** From each SDK's documented method and option names
(data in src/scan/sdkclients.ts):
- Clients by method path: ruby-openai (`client.chat(parameters: {…})`, `client.assistants.*`, `threads`, `runs`), the
  anthropic gem (`client.messages(parameters: {…})`), openai-php and its Laravel facade (`$client->chat()->create([…])`,
  `OpenAI::assistants()->list()`), the Anthropic PHP client (`$client->messages->create(temperature: …)`, named
  arguments). A call with no settings is reported on its line too.
- Typed requests: OpenAI .NET `ChatCompletionOptions`, Anthropic.SDK `MessageParameters`, Microsoft.Extensions.AI
  `ChatOptions` (for the client the file wires: Anthropic or OpenAI, "possible"), Spring AI
  `AnthropicChatOptions.builder()` / `OpenAiChatOptions.builder()`, go-openai and openai-go request structs.
- SDK methods that name the operation: go-openai `CreateAssistant`, `ListAssistants`, `CreateThread`, `CreateRun`…,
  `CreateChatCompletion`; OpenAI .NET `AssistantClient` and `ChatClient.CompleteChat`.
- Spring AI settings: `spring.ai.anthropic.chat.options.temperature` / `top-p` / `top-k` (and OpenAI's) in
  application.properties and application.yml.

**Trace time and memory back to step 2's.** A default export is searched for by its module's path (the word
"default" matched every file: erxes's wrapper traces went from 32 s to 1.8 s); otherwise a caller must name the
definition. Each function is carried once per version and provider. Files outside the kept sources are read through a
word filter once and not kept; the line cache is small; pass-only text is dropped after the call map passes.

**One finding per version constant.** In the file that binds a version, its uses (requests interpolating it, a URL
built from it, a function returning one) are lines of the constant's finding (alsoLines), not findings of their own;
in another file, the first use is that file's usage and later uses are its lines. Uses that start a cross-file trace
are kept only for the trace (`traceOnly`) and dropped from the scan's output. A TypeScript type word (`| undefined =`)
is no longer read as a constant's name.

**Recall: the call map's read budget counts each file once.** The trace candidate search reread files the prefilter
skipped and counted every reread, so on a large repo the budget ran out partway through and later searches missed
files. Now a file counts the first time it's read.

**Fixes 6, 7 and 9.**
- Transports: a function that builds its URL from a provider base written in it plus one of its own parameters
  (`${baseUrl}${endpoint}`) is followed to its callers; the path each passes is the operation
  (apiRequest.call(this, 'POST', '/audio/translations') → POST /v1/audio/translations).
- Declarative routing: `routing: { request: { method, url: '/v1/edits' } }` with the base URL from the same file or
  the node file importing it.
- Configuration read by key: `config.get('WA_BUSINESS').VERSION` (or `get('wa.version')`), when exactly one object in
  the repo binds that key and field to a provider version and the read goes into a URL in the next lines.
- A request header pin (OpenAI-Beta: assistants=v1) also stands for the URL built next to it in the same function.

**Feed-driven trace starts.** With a local feed, a version or URL constant starts a wrapper trace only if some
record matches it (`watchOrigin`): a traced usage copies the fields a record reads from where it starts, so findings
don't change; the scan cache is keyed by the feed too (`watchKey`). `VITASTA_NO_WATCH=1` turns it off.

**Request settings in every language's spelling (item 5).**
- Ruby, PHP and C# clients for providers whose calls are named paths (Anthropic, OpenAI: `client.messages.create`,
  `$client->messages()->create([...])`, `client.Messages.Create(new MessageCreateParams { Temperature = … })`, a
  request object built earlier in the method included): each key is read and written the wire's way. Data: CLIENTS
  (how each language makes a client); the operation comes from the provider's sdkOps.
- C#: a second typed Stripe options object setting the same field in a file is reported too (it was taken for the
  first).

**Gateways (call map fix 2).** An OpenAI-compatible request to a model gateway (OpenRouter, Vercel AI Gateway,
Requesty: data in `GATEWAYS`) reaches Anthropic when the model it sends is shown to be one of Claude's: a Claude id
written as the model, or the request's own model variable tested against Claude ids (a set of "anthropic/claude-…"
ids it's checked against, here or in the module it's imported from, a workspace package included; or a prefix test
like `model.startsWith("anthropic/")`). Its sampling settings are then reported for Anthropic too ("possible", the
gateway named in `via`). A gateway call with no such sign stays the gateway's.

**Precision: a version named in a message isn't a setting.** An SDK setter written inside a prose string (an error
or help message: "please specify an explicit API version (e.g., ApiVersion.July26)") is no longer a version pin, so
it isn't reported or traced to callers.

**URL = a base constant + a path (call map fix 3).**
- A URL setting that starts with an imported versioned base (`url: \`${WHATSAPP_API_BASE}${path}\``, `BASE + path`,
  `f"{BASE}/me"`) counts like one given the base itself; each URL setting in a file is reported (each configures its
  own requests), the first other use near a call once.
- In the binding's own file, a function returning the versioned URL (`getBaseUrl(shop)`), or a name built from it
  (`GRAPH_API_URL = f"…/{GRAPH_API_VERSION}"`), is reported where the URL is made, so its callers and importers are
  traced; an object member in the same file calling it (`helpers.getBaseUrl`) carries it on.
- A version setting given an imported version constant (`{"version": GRAPH_API_VERSION}`, `apiVersion: V`) counts,
  for the provider whose versions look like it and whose name its module or the file names.
- Direct callers of a wrapper are reported per carrier, not hidden by an unrelated request with the same version in
  the file; deeper hops stay one per file and version.

**Request settings through repo wrappers and monorepo packages (call map fix 4, part 1).**
- AI SDK wrappers: a repo function that hands its own `model` and settings to generateText / streamText
  (runChatCompletion({ model, temperature })) is followed to its callers; the provider is the model the caller passes
  (createAnthropic({ apiKey })(name)), and each setting the wrapper forwards is reported where the caller sets it.
  The installed @ai-sdk/anthropic release decides, as for a direct call.
- Workspace packages: an import by a package's name (`@acme/ai/runChat`) links to that package's folder (src/ or lib/
  included), when exactly one package has the name.
- A named body sent more than once (posted, then posted again in a tool loop): the setting's finding lists each line
  that sends it.
- With a local feed, keys traced through wrappers are kept only when some record selects them (`watchParams`).

**Faster cross-file passes (call map step 3, part 1).** Same findings:
- Versions held in variables: each file is tested once for the SDK option setters and provider URL slots it can
  match, and only those are run line by line. Before, a setter's file test ran once per line (quadratic on large
  files). erxes: 7.9 s to 1.7 s.
- Call map trace candidates: each distinct word a search needs is looked for once per file before the full strings.
  erxes: 4.6 s to 2.8 s.

**Less memory and disk for the call map and scan cache (call map step 2).**
- The call map keeps calls only for files with provider findings; other files keep imports, exports and definitions,
  and their calls are read again when a trace reaches them. Calls no trace can use (`console.log`, `res.json()`) aren't
  indexed.
- Traces look only in files that name the definition or its module in an import, not every file using a common
  member name (`get`, `create`).
- The SDK-through-a-repo-module pass reads only modules that name an SDK package, or re-export from one.
- Scan cache: one pack file of gzip blocks with a small index, read a block at a time; entries are no longer copied
  in memory; the pack holds only the entries the last scan used (about 4 MB for a 9,600-file repo).

**Findings for the right record (call map fix 1).**
- A feed record can list header values that mean the code uses what it covers (`headers: ["openai-beta:
  assistants=*"]`). A request sending one matches that record wherever it's sent, through a shared request helper
  or a client's default headers. Before, a version pin never matched a record that wasn't a version sunset.
- A request whose URL interpolates a name bound to its provider's version in the same file
  (`${this._baseUrl}/${this._version}/…` with `private _version = 'v19.0'`) carries that version, also when the URL
  starts on the line after the call opens. Version sunsets now match the request, not only the binding.

**Call map pilot (TS/JS and Python).** Findings that cross files, and a scan cache:
- A per-file index (imports, exports and re-exports, definitions, calls; structure only, never string values) links
  imports to the file and definition they name. An import that could be more than one file links to none (a missed
  link, not a guess); Python absolute imports resolve from the importing file's source root or the repo root only.
- From each provider call, up to 3 hops: a version set inside an exported wrapper is reported where callers use it;
  an exported URL constant with a version is reported where another file sends to it or sets it as a base URL; keys a
  caller puts in params that a wrapper forwards to the SDK (`**params`, `...opts`) are reported where they're set.
- An SDK imported through the repo's own module (`from app.stripe import stripe_lib`) counts as the SDK.
- Versions imported by name resolve through the import, not by the nearest file with the same name; versions set
  over several parenthesized lines and through a namespace member (`WHATSAPP.API_VERSION`) count.
- Scan cache (opt-in, `cacheDir` or `VITASTA_SCAN_CACHE`): per-file entries keyed by git blob hash, findings without
  code lines, folder 0700 and file 0600, written atomically, ignored when corrupt or from another build, feed or
  config. git is only asked for the commit and the changed-file list, with hooks, fsmonitor and external diff off.

**Anthropic bodies in more shapes, fewer other providers' bodies taken for Anthropic's (v17).** From mining public
uses (repos outside every test set):
- Python: a name bound to clients of two providers (`model = anthropic.Anthropic()` in one branch, `GenerativeModel()`
  in another) resolves by the call; `messages.create` is Anthropic's.
- A shorthand key on its own line (`temperature,`) is sent when it's directly in an object literal; a destructuring
  pattern (`const { temperature } = opts`) or a parameter list isn't.
- Functions are found in more forms: object methods (`callAnthropic: async function (…)`, `build: (s, r) => {`) and
  `export default function`.
- Python: `'"""'` inside an ordinary string no longer reads as opening a triple-quoted string (which hid every
  function after it).
- When a function also names another provider, the scope is the branch around the Anthropic endpoint (the `else if`
  that builds the body), not just the `fetch(…, { … })` options object.
- Precision: a generic name holding the endpoint (`url: 'https://api.anthropic.com/v1/messages'`) no longer makes every
  `url` in the file Anthropic's. v16 reported OpenAI-compatible and Mistral bodies in such files.
- A provider-named function whose signature runs over several lines (`buildAnthropicBody(String model,` …) counts.
- AI SDK (`generateText` and the like):
  - a model picked at runtime counts as Anthropic's when a name in the `model:` expression reaches an Anthropic
    factory from `@ai-sdk/anthropic` in the same file, within three hops (`getModel(opts)`, `resolveProvider(cfg,
    providerMap)`); the finding names the path;
  - sampling settings (temperature, top_p, top_k) are judged by the installed `@ai-sdk/anthropic` release (lockfile,
    or the manifest's minimum) against `src/data/ai-sdk-anthropic-sampling.json`, read from each release's published
    source. Sent by the release: a break. Dropped for that model: not a finding. Model picked at runtime on a release
    with the drop logic, or a release that isn't confirmed: a note. A model picked at runtime with no manifest naming
    the package isn't a finding;
  - comments and one-line strings are blanked properly when reading the call's options (an apostrophe in a comment hid
    every call after it).

**Imports don't name a service, versions named for something else, config reads aren't sends (v16).** From blind
set 6 counts on v15:
- A brand in an import line or a module path (`github.com/acme/app/pkg`) no longer counts as the nearest service.
  v15 dropped Meta and Shopify version constants that sit below a Go import block.
- A version assigned to a name for another thing's version (`appVersion`, `SCHEMA_VERSION`, `protocol_version`) is
  that thing's, unless the name also names the provider.
- Anthropic: a local declared from elsewhere (`var temperature = _config.Temperature`) isn't reported; the request key
  it's put under is.

**Version catalogs, the nearest service owns a version, Meta and Anthropic shapes from public code (v15).** From
mining public uses (repos outside every test set), and the two false-alarm categories in test sets:
- Precision:
  - versions listed in an enum, a list or a block of version-named constants are a catalog, not calls;
  - a version belongs to the nearest named service on the line or in its block (a `v2.1` next to another brand or
    another host isn't Meta's).
- Meta:
  - versions `v2.10`–`v2.12` read as versions;
  - numeric settings in more shapes (`define("GRAPH_VERSION", 2.8)`, Ruby `api_version '15.0'`, any modifiers);
  - getters returning a version constant, `${version()}` and PHP `'…' . CONST` in URLs;
  - SDK options set from a name over several lines; constants in modules the prefilter skipped;
  - facebook-sdk `GraphAPI(version=…)`, WhatsApp and Messenger clients;
  - library defaults: facebook-business (Python) and facebook-nodejs-business-sdk (version follows the package),
    ASP.NET Core Facebook auth, whatsapp-api-js 2.6–5.2; Python lockfiles (uv, poetry, Pipfile, requirements);
  - Apps Script (`.gs`) files and notebook code cells.
- Anthropic temperature / top_p / top_k:
  - keys written inside a function or branch that sends to Anthropic (URL, URL constant, SDK client, langchaingo,
    builders), plus helpers it calls in the same file, functions named for the provider, and files named for it that
    send something themselves;
  - a function that also names another provider counts only in the block around the Anthropic call;
  - not counted: keys in strings or comments, retrieval / formatter arguments, parameter copies, getters, several
    names assigned or returned at once, locals read from a getter, validation schemas, converters named for two
    providers, and files that only read a request (telemetry, translators) without sending one.

**Read budget by priority, versions in more shapes, request bodies, library defaults (v14).** From test sets:
- Past the 100 MB source budget, the scan keeps the files most likely to call an API, not the first ones listed. The
  order is app code naming a provider host, then other app code, then tests and docs, with smaller files first. A
  large monorepo's nodes and credentials folders were left out before.
- Versions:
  - a version followed directly by an interpolation (`…/v21.0${resource}`), including in tagged templates;
  - versioned provider URLs in YAML / JSON / TOML configuration;
  - a numeric version setting put after a literal `v` (`API_VERSION = 24.0` → `v{version}`), and same-file aliases
    (`version = self.setting('API_VERSION', self.API_VERSION)`);
  - a version given as a call's fallback (`getattr(settings, …).get('VERSION', 'v19.0')`);
  - config getters by key (`configService.get('WA_BUSINESS').VERSION`);
  - names bound to an SDK enum (`SHOPIFY_API_VERSION = ApiVersion.October24`), and Shopify Storefront URLs
    (`myshopify.com/api/2024-10/`), on Shopify's host only;
  - SDK options set from a constant (`new WhatsAppAPI({ v: WA_VERSION })`), which also overrides the library default;
  - fbgraph's `setVersion`, with the modules that import the client it sets.
- Anthropic request settings (temperature, top_p, top_k) read from bodies built elsewhere:
  - raw HTTP calls naming `/v1/messages`;
  - anthropic-sdk-go `MessageNewParams`;
  - `ChatAnthropic` and the config objects handed to it;
  - helpers spread in;
  - payloads merged before posting.
- Library defaults, read from each library's release source:
  - passport-facebook (v2.2 / v2.5 / v3.2);
  - fbgraph (API v2.4 / v2.9; login dialog v2.0);
  - Laravel Socialite through `buildProvider(FacebookProvider::class)` and subclasses that don't set `$version`.
- Precision:
  - a version in a `.env` file that no code reads is a copy for users;
  - Claude on Vertex AI / Bedrock (`AnthropicVertex`) and the Anthropic SDK pointed at another host aren't reported
    under `/v1/messages` (a model they name still is);
  - Python typed params constructors (`SetupIntentCreateParams(…)`) passed to wrappers.

**Wrappers, versioned base URLs, and Microsoft Graph kept apart (v13).** From test sets:
- A bare `GRAPH_API_VERSION` isn't Meta evidence. Microsoft Graph's host, SDKs, Outlook and its `'v1.0'`/`'beta'`
  pair rule a line out.
- Stripe calls:
  - `create_async` / `CreateAsync` are their operation;
  - Ruby hashes that open on the next line, and `update(id, k: v)` keyword args;
  - C# target-typed `new() { … }` options;
  - PHP Stripe client chains on any receiver, when the resource is a known Stripe resource.
- Base URLs:
  - a held base URL may carry a path (`https://graph.facebook.com/v23.0`, `https://api.openai.com/v1`); the operation
    is the full path;
  - base constants imported from another module resolve through the import path;
  - JSON providers can give `versionToken` / `versionEvidence` (Google Ads `v25`).
- Literal versioned URLs count once per line, not once per file.
- `WA_BUSINESS.VERSION` resolves to the binding inside that object.
- Shopify `ApiVersion.July25` is 2025-07. A Ruby config chain read in the same initializer counts.
- Library defaults: ASP.NET Core 10 (v22.0), Messenger factory wrappers, and the lockfile / manifest / csproj row that
  pins the library (it fails a check, like the use).
- The AI SDK model can be held in a variable. `env.example` / `env.sample` files are read.
- A version pin in a folder named after that version (generated per-version code) is a catalog, outside tests.

**Imports decide holders, config chains, library defaults (v12).**
- A getter or object property holding a versioned URL resolves only through an import whose path leads to the
  module that defines it. Ruled out:
  - a local declaration of the same name;
  - a `this.` method;
  - an export list;
  - another package's export.
  Files the prefilter skips are read for these uses too.
- Ruby configuration blocks (`ShopifyApp.configure do |config| config.api_version = …`), reported where
  `ShopifyApp.configuration.api_version` is read.
- `.env` / `.env.example` values and compose `environment:` lines (`- WA_BUSINESS_VERSION=v18.0`). Meta env prefixes
  (`WA_`, `FB_`, `IG_`, `GRAPH_API_VERSION`) count as Meta.
- SDK clients from other modules, matched against the provider's op table by prefix (`openai.beta.threads.runs.stream`).
- The Vercel AI SDK (`generateText` / `streamText` with an `@ai-sdk/<provider>` model): options become the provider's
  params (`topP` → `top_p`). Spread helpers (`...spreadIfDefined('temperature', t)`) add their key.
- Library defaults (`src/data/library-defaults.json`, read from each library's source at release tags):
  - omniauth-facebook, Laravel Socialite, ASP.NET Core `AddFacebook()`, whatsapp-api-js, messaging-api-messenger;
  - the version comes from the nearest lockfile or manifest, and an explicit override wins.

**Adapter-style code, generated clients and data flow everywhere (v11).**
- Typed Stripe requests name their operation wherever they're passed, the app's own adapters included:
  - C# `new SetupIntentCreateOptions { … }`;
  - Go `&stripe.CheckoutSessionParams{}`;
  - Java `SessionCreateParams.builder()`;
  - Python `stripe.SetupIntent.CreateParams` dicts.
  Fields set later on the same variable count too.
- Java Map params (`params.put("k", …)` before `Session.create(params, requestOptions)`).
- Generated fluent clients: Microsoft Graph's call chains (`client.users.by_user_id(x).messages.get()`, C#, Java, Go,
  PHP, and `client.api('/x')`) become their operation; v1.0 or beta comes from the package.
- A provider's base URL held in a name (`${resource}/v1.0/…`, `{$this->apiUrl}/…`, `BASE + "/v1/…"`) with the method
  from the call around it. A name with several values in the file isn't followed.
- HTTP clients with a base URL (Faraday, httpx, Guzzle, HttpClient BaseAddress, got/ky), Ruby `Net::HTTP::Post.new`,
  PHP `curl_init` with `CURLOPT_POST`.
- Data flow:
  - Python: builder returns, wrappers traced back to callers (in other files too), conditional `**({…} if c else {})`.
  - JS: `p.k =`, `p['k'] =`, `Object.assign`.
  - Ruby: `.merge(…)`. PHP: `array_merge` and `+=`.
  - Go and C#: field assignments after construction.
- Versions through other files:
  - object properties (`META.API_URL`);
  - getters (`getBaseUrl(shop)`);
  - config modules with env fallbacks (`process.env.X || 'v18.0'`, `os.getenv`, `ENV.fetch`);
  - PHP class properties (`{$this->version}`).

**Two modules and an API coverage matrix (v10).**
- Every finding says which module found it: `module: "ai"` (model IDs, LLM params of AI providers) or `"api"`
  (versions, endpoints, params).
- `test/coverage/cells.ts` holds one cell per provider × language × call style, written from each SDK's documented
  call shapes. `npm run coverage-matrix` prints what's covered.
- Stripe in Go, Java and C#: static and client calls (`paymentintent.New(&stripe.PaymentIntentParams{…})`,
  `sc.V1PaymentIntents.Create`, `PaymentIntent.create(params)`, `client.v1().paymentIntents().create`,
  `new PaymentIntentService().Create(options)`, `client.V1.PaymentIntents.Create`). Go struct fields, Java builder
  calls and C# option properties are the params, followed to a local built earlier in the function.
- Stripe clients in Python (`client.v1.payment_intents.create(params={…})`) and Ruby
  (`Stripe::StripeClient.new` … `client.v1.payment_intents.create`).
- Version setters as provider data, in any language:
  - Stripe: `Stripe.api_version =`, `setApiVersion`, `setStripeVersionOverride`, `StripeVersion =`, `stripe_version=`;
  - Meta: `GraphAPI(version=)`, restfb `Version.VERSION_19_0`, `Koala.config.api_version`; `FB.init` counts as Meta;
  - Shopify: the Python `Session(shop, '2024-10', …)`, and the `X-Shopify-API-Version` header.
- Versioned URLs in PHP, Go and C# strings.
- First-entry defaults in Java (`.get(0)`, `.getFirst()`), C# (`.First()`), Ruby (`.first`), Go and Python.

**PHP SDK calls, conditional params, first-entry defaults (v9).** From the third test set:
- PHP Stripe calls: static resource calls (`\Stripe\PaymentIntent::create([...])`, `Session::create` with
  `use Stripe\Checkout\Session;`) and client calls (`$stripe->paymentIntents->create(...)`). The request array is
  followed into locals, `$data['k'] = …`, methods that return it, and wrappers whose first parameter is the request:
  in the same file, and called from other files (`$this->stripe->createPaymentIntent($data)`). A receiver merely
  named after the provider counts only for SDK-shaped calls (no underscores, an operation verb), in JS too.
- Conditional spreads add their keys: `...(cond ? { k: v } : {})`, `...(cond && { k: v })`.
- A version list whose first entry the code takes as its default (`current(self::versions())`, `reset()`, `head()`,
  `Arr::first()`, `[0]`): that entry fails a check, the rest stay a catalog, and each place that takes it is reported.
- The Conversions API (`graph.facebook.com/vNN/{pixel}/events`) belongs to the Marketing API.
- Stripe's local helpers and setup calls (`webhooks.constructEvent`, `\Stripe\Stripe::setApiKey`,
  `Stripe::StripeClient.new`) aren't API operations.

**API versions and params followed further (v8).** From the second test set:
- A version held in a variable or constant is followed into provider URLs: a local (`const apiVersion = "v20.0"` …
  `graph.facebook.com/${apiVersion}/…`), or a constant another file imports (each import resolves to its own
  module). Reported at the binding, where the fix goes, and once in each file that uses it.
- A version-led path handed to a helper that adds the host (`getApiUrl('v2.8/me')`).
- Params built away from the SDK call, within a file: a builder's return value, a wrapper's parameter traced back to
  its callers (through callbacks), and helper calls through their arguments, up to four steps. Each key is reported
  on the line where it's written.
- Ruby SDK calls for providers whose operations follow a naming rule (`::Stripe::Checkout::Session.create(payload)`),
  with the payload followed into a local or another method of the file (`payload[:key] = …` included).
- A client another module exports, named after the provider (`stripe.paymentIntents.create` with
  `import { stripe } from "@/lib/stripe"`). A naming-rule provider counts only on a receiver named after it.

**API versions where real code writes them (v7).** From the test set:
- A version outside a full URL counts when the provider is named on the line, just above it, or in the path. That
  covers a version constant or default (`WHATSAPP_API_VERSION = 'v14.0'`, `load('FACEBOOK_API_VERSION', 'v18.0')`,
  `STOREFRONT_API_VERSION = "2026-10"`), a parameter default, a templated path whose host is a variable
  (`"#{api_base_path}/v13.0/#{id}"`), and a config entry (`name: FACEBOOK_API_VERSION … value: 'v18.0'`). Each
  provider gives its version shape and the words that tie code to it; words for another API rule a line out (Threads'
  `v1.0`, Shopify's Partner API). Three or more versions together are a catalog, a version in a comment is copy.
- The Facebook login dialog (`www.facebook.com/v19.0/dialog/oauth`) follows Graph's versions; the website's other
  pages aren't the API.
- Ruby strings are read for versioned URLs.
- Params built before the call: `create(params)` with `const params = { … }` earlier in the same function (JS, and
  `{ ...base }` spreads), and `create(**params)` with `params["k"] = …` (Python). The first argument is the body; an
  options object after it isn't.
- In tests, a versioned URL that a stub or an assertion matches (WebMock, `toMatchMadeHttpRequest`, nock, `expect`)
  is asserted.
- A model catalog whose first or chosen entry the app uses (`agentModel: defaultQAModels[0]`) is a default, so its
  places still fail a check.

**Model catalogs and registries are notes (v6).** A model in a list the app offers, rather than a value it sends,
is a catalog entry: it's reported, and never fails a check.
- An entry whose object describes the model (price, context or output limits, capabilities, modalities), directly or
  one level down: model pickers, provider definitions, price tables.
- A list of three or more entries that each name a model by an ID key (`id`, `modelId`, `apiModelId`, `slug`):
  model registries and provider registries' mappings. Gateway mappings are notes too.
- Never: an object passed straight into a call, a preset or request (`temperature`, `messages`, `contents` …), a
  provider configuration (API key, base URL, `enabled`), an assignment (`req.model = "…"`) or a return.

**An optional second stage (experimental, off by default).** `--catalog-model` (or `VITASTA_CATALOG_MODEL=1`) runs a
small logistic regression over the shape of each remaining "breaks" place: sibling entries and their fields, the
name holding the list, nesting, and whether the value sits in a call, assignment or return. It can only turn a place
into a catalog entry, with its score in the reason. Its weights ship in `src/data/catalog-model.json`; it has no
runtime dependency and reads nothing outside the file.

**Data files follow their own rule.** A model in a YAML, JSON, TOML, INI, `.properties` or `.env` file fails a check
only when the file is runtime configuration:
- a known config name or place: `.env`, `config.*`, `settings.*`, `application.properties`, compose files, CI
  workflows, `config/`;
- or a file the repo's code loads, by its name, its path or its folder.

Other data-file places are still reported, as recorded data or catalog entries. Code files keep the existing rules.
- Release notes, changelogs, `website/_data`, and benchmark and leaderboard data are recorded.
- Test projects (`Foo.IntegrationTests/`, `api-tests/`) and test settings files are tests.
- Agent skill assets and migration guides are examples.
- A setting in a settings registry the code reads (`weak_model_name: …`) counts as a setting, however many models the
  file lists.
- A data file that only tests load, or one under `__data__/` or `testdata/`, is test input, not configuration.
- Test-support modules (`testing.py`, `testutil.go`, `test_helpers.ts`) are tests.
- A value written only to a log or a run record (`run_metadata`, `summary`, `print`, `logger.*`), or a React
  context's default value, is recorded.
- Python: a local name resolves to its value at that point in the function, not to an assignment later in the
  function or in another branch.
- A model only compared against in code (`model !== 'cohere.command-text-v14'`, `case "o1":`, `startsWith(…)`) is a
  catalog entry: it picks a branch and nothing sends it. In tests a comparison is still an assertion.
- A field default in a Python response schema (`class VideoResponse(BaseModel): model: str = …`) is recorded; a
  request schema's default still fails a check.
- Span and trace attributes (`set_attribute`, `setAttributes`, `add_event`, `set_tag`) are recorded.
- Fixture folders by any name (`session-fixture/`) are tests; `seeder/` and `seeding/` data is recorded.
- Code shown to users is an example: `snippets/`, `*-snippets.ts`, `code-samples/`, `integration-scripts/`, and
  code in another language inside a web app's source tree (`frontend/src/…/*.py`).
- Translation files (`locales/`, `i18n/`, `en.json`, `messages.fr.yaml`) are user-facing text, not configuration.
- Benchmark harness code is no longer a test: a benchmark that calls a retired model fails. Benchmark result data is
  still recorded.
- In a test that mocks the provider client, a model no assertion names is test data, so a fix doesn't edit it.

## 0.1.5 (19 Nov 2026)

**Where a model is used decides what happens with it.** Every place now has a role:
- **Live code, defaults, config:** the only places that fail a check.
- **Examples and docs, including README code blocks and code samples in strings and docstrings:** shown and
  annotated, never failing.
- **Tests:** split into tests that set or check the model (a fix updates them) and tests that only store, show or look
  it up.
- **Model lists, catalogs, price tables, model-to-model maps:** never renamed.
- **Recorded data (telemetry, recorded responses, saved runs):** information only.

Nothing is silently dropped any more: price tables, recorded responses and lists the code only checks names
against are reported in their roles.
- **Reports** group places by role. A pull request's check annotates what it touches in live code and in examples.
- **More model places found:**
  - environment-variable defaults (`os.getenv("X", "gpt-4o")`, `process.env.X ?? "…"`);
  - gateway prefixes (`mastra/openai/gpt-5-mini`);
  - commander `.option(flags, description, default)`;
  - form fields named "Model";
  - framework model classes (`Claude(id=…)`, `OpenAIChat(id=…)`);
  - destructured parameter defaults;
  - provider/model routes in provider- or LLM-named constants;
  - code blocks in Markdown and code samples in template strings and Python docstrings.
- **Partner vendors' model IDs on Azure and Bedrock** are recognised by vendor family, from
  `src/data/partner-models.json`. Examples: Llama, Phi, MAI, DeepSeek, Cohere, Mistral, Kimi and FLUX on Azure;
  `<vendor>.<model>` IDs, with region prefixes, on Bedrock. Partner IDs count only where the code runs the model on
  that platform.
- **Fewer false alarms:** a router named only in a comment no longer turns provider routes into router IDs. Token and
  size helpers' default models aren't uses.
- **Security:**
  - A repository's own `.vitasta.yml` patterns can't stall a scan: bounded repeats up to 32, a shared time budget
    per scan, and V8's linear-time regex fallback.
  - Scans of large or unusual files stay linear. Each scan has a cap on source size, and each manifest a 1 MB cap.
  - No symlink is followed.
- **Lookups and MCP:**
  - The date lookup sends only IDs made of public model words, never deployment names, codenames or anything
    secret-looking.
  - The MCP server scans only inside the client's roots, `--root` or `VITASTA_MCP_ROOTS`, never `/` or the home
    folder.
  - MCP answers quote repository text as JSON strings.
- **Output and redaction:**
  - Report and annotation text drops control and bidirectional characters.
  - About fifteen more secret formats are redacted in snippets.
  - A repository's provider can't reuse a built-in provider's name.
- Dev dependency: vitest 4.1.12 (npm audit clean).

## 0.1.4 (18 Nov 2026)

- **What a date means:** records can say what happens on the date: it stops working, it can stop any day from then
  ("not sooner than"), calls silently move to another model, or the API becomes read-only. Reports, checks and the
  MCP server word each one accordingly ("can be retired", "will silently change to …", "becomes read-only").
- **Models whose versions retire on different dates** (Azure): with no version in the code, a model is "partly
  retired" until its last version's date, with each version's date, instead of "retired" from the first one.
- **Replacements that are themselves retiring:** "Move to" follows the provider's named replacement through the feed
  to the first model that isn't retired or retiring soon on the same platform, and says why
  ("gpt-5.6-terra (the provider names o4-mini, retired since 2026-10-23)").
- **One clock:** dates are judged in UTC everywhere, and a model on its retirement day reads "retires today".
- **Every finding says when it was last checked** against the provider's page.
- **PR checks use the base branch's policy:** `vitasta check` (and the Action) read `.vitasta.yml` from the base
  branch, so a pull request can't loosen its own check. Without one on the base, the default policy applies.
- **GitHub Action:** runs the built scanner with production dependencies only (no build tools in your CI), and
  `actions/setup-node` is pinned by commit. Use a release tag: `uses: vitasta-dev/vitasta@v0.1.4`.
- **Lookup answers are checked field by field** (lengths, characters, dates; links only on providers' docs sites),
  and MCP answers say they are data, not instructions.
- **MCP `model_status` sends only public model IDs** (a fine-tune by its base model; deployment names never) and
  prints the same lookup notice as the CLI.
- **More model settings found:** a property descriptor's default for a model setting, including resource locators
  (`{ name: "model", default: { mode: "list", value: "…" } }`).
- Dependencies: `yaml` 2.9.1 and `zod` 4.6.7 (security fixes).

## 0.1.3 (18 Nov 2026)

- **Where a model runs:** a model the code places on a platform gets that platform's dates. Read from an entry's
  provider field, the key, call or branch it sits in (`azure:`, `VertexAIProvider(...)`, `elif api_type == "azure":`),
  the file's path, or the only platform endpoint the file talks to. GitHub Models, Copilot, the ChatGPT app, VS Code's
  model API and SAP AI Core aren't the provider's API, so its API dates don't apply there. Data:
  `src/data/model-platforms.json`.
- **Fewer false alarms:** model names used to test a name (prefix, substring and membership checks, also across files),
  capability and compatibility tables, display labels, tokenizer names, schema and OpenAPI examples, retirement
  knowledge bases, vendored copies under docs/, lint-rule fixtures, demo data files, bundled `.min.js`/`_bundle.js`.
- **More real uses found:** defaults of model-named flags and options (`getArg('--model', …)`, argparse/click
  `default=`, `z.string().default(…)`, `Field(default=…)`), `llm_name`/`deployment_name` settings, a model object's `id`,
  model-info registries keyed by ID and constructor rows (`ModelInfo(id=…)`), model→provider maps, a model config picked
  by ID, embedders.
- **Compatibility data for model moves:** a reader for what a replacement model rejects or does differently (request
  settings, response changes, and the first SDK version per release line that handles it), used by fix pull requests.
  The SDK version a place in the repo runs with is read from its lockfile (npm, Bun, pnpm, Yarn, Poetry, uv, PDM,
  Pipenv) or its manifest's range. Only files are read; nothing is installed.
- Groq's `deepseek-r1-distill-llama-70b`-style IDs are recognised.
- **Fix:** a name holding a short word inside another word (`ClaudeModel` holds "demo") is no longer taken for a
  non-setting.
- **Fix:** the MCP server reports the package's version (it said 0.0.1).

## 0.1.2 (17 Nov 2026)

- **Large repos:** no more out-of-memory crash on repos with thousands of matching files (syntax trees are freed file
  by file; peak memory on an 8,000-file repo went from 2.3 GB to 0.43 GB).
- **API versions in any URL:** a URL on a versioned API's host pins that version wherever it's written: base-URL
  constants, settings fields, wrapped fetch calls, helpers, and Shopify's `/admin/api/YYYY-MM/` even when the store host
  is a variable.
- **Models in more places:** model enums, per-provider maps, alias maps, model lists and preset rows, registry entries
  (code, YAML and JSON) and models passed to model-shaped calls. These count when the repo shows it uses that provider
  (an SDK or HTTP call, an SDK or framework dependency or import, a model CLI or container, or its API key env var).
- **Less noise:** recorded API responses, data files (results, logs, recordings), display-name maps, alias and snapshot
  lists, membership checks, pricing and cost code, placeholders and commented-out config lines don't count. A path
  segment built at runtime no longer matches a specific removed endpoint.
- **Tests listed apart:** findings in tests, examples, fixtures, mocks, samples and seed data are listed at the end of
  the report, and a PR's summary no longer counts ones it didn't touch.
- Groq IDs with a context-length suffix (`llama3-70b-8192`) are recognised.

## 0.1.1 (17 Nov 2026)

- New providers: Together AI, OpenRouter (including through the OpenAI SDK), Google Ads API, and the Meta Marketing
  API, which has its own (shorter) version schedule: the Business SDKs and `/vNN.0/act_…` calls get Marketing dates,
  other Graph calls keep Graph dates.
- Provider-prefixed model IDs as frameworks write them (`anthropic/claude-…`, `bedrock/…`, `vertex_ai/…`), skipped in
  files that use a router whose own IDs look the same.
- Model IDs that are the default of a `model` flag or option (Go `StringVar`, `flag.String`, `.option("--model")`).
- OpenAI prompt objects: `prompt: { id: "pmpt_…" }` in Responses calls, and quoted `pmpt_` IDs kept in constants.
- Fewer false alarms: a model ID used as a lookup-table key (colours, sizes, prices) isn't a use, and models that are
  only offered (lists, pickers, registries, type unions) are reported as "listed" and never fail a PR check.
- Lookup privacy: org/model IDs are sent only for well-known public orgs; a company's own names never are.

## 0.1.0 (16 Nov 2026)

First release: CLI, GitHub Action and MCP server.
