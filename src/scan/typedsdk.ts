/**
 * v10: SDK calls in Go, Java and C# for providers whose operations follow a naming rule (Stripe). Text-based, like the
 * rest of the support for these languages:
 *   Go    paymentintent.New(&stripe.PaymentIntentParams{…}), sc.V1PaymentIntents.Create(ctx, params)
 *   Java  PaymentIntent.create(params), client.v1().paymentIntents().create(params)
 *   C#    new PaymentIntentService().Create(options), client.V1.PaymentIntents.Create(options)
 * The request's fields are the params: Go struct fields (PaymentMethodTypes → payment_method_types), Java builder calls
 * (.addPaymentMethodType("card") → payment_method_types, .setAmount(1L) → amount), C# option-object properties. A
 * request held in a local is followed to where it's built in the same function. Each field is reported on its line.
 * Resource names come from a data table (RESOURCES): the SDKs' type names with the separators taken out.
 */
import { providerById, sdkOp } from "../providers.js";
import type { Usage } from "../types.js";

const MAX_LINE = 2000;
const MAX_BACK = 120;

/** Stripe resources: lower case without separators → the class path stripeOp reads (namespace.Class) */
const STRIPE_RESOURCES = [
  "Account", "AccountLink", "AccountSession", "ApplePayDomain", "ApplicationFee", "Balance", "BalanceTransaction", "BankAccount", "Card", "Charge",
  "Coupon", "CreditNote", "Customer", "CustomerSession", "Dispute", "EphemeralKey", "Event", "File", "FileLink", "Invoice", "InvoiceItem", "Mandate",
  "PaymentIntent", "PaymentLink", "PaymentMethod", "PaymentMethodConfiguration", "PaymentMethodDomain", "Payout", "Plan", "Price", "Product",
  "PromotionCode", "Quote", "Refund", "Review", "SetupAttempt", "SetupIntent", "ShippingRate", "Source", "Subscription", "SubscriptionItem",
  "SubscriptionSchedule", "TaxCode", "TaxId", "TaxRate", "Token", "Topup", "Transfer", "TransferReversal", "UsageRecord", "WebhookEndpoint",
  "checkout.Session", "billing_portal.Session", "billing_portal.Configuration", "identity.VerificationSession", "terminal.Reader",
  "terminal.Location", "terminal.ConnectionToken", "radar.ValueList", "tax.Calculation", "tax.Transaction", "billing.Meter", "billing.MeterEvent",
  "financial_connections.Session", "issuing.Card", "issuing.Cardholder", "issuing.Authorization", "treasury.FinancialAccount",
];
const RESOURCES: Record<string, Map<string, string>> = {
  stripe: new Map(STRIPE_RESOURCES.map((r) => [r.replace(/[._]/g, "").toLowerCase(), r])),
};
export const resourceOf = (provider: string, name: string): string | undefined => {
  const key = name.replace(/[._\s]/g, "").toLowerCase();
  const m = RESOURCES[provider];
  return m?.get(key) ?? (key.endsWith("s") ? m?.get(key.slice(0, -1)) : undefined) ?? (key.endsWith("ies") ? m?.get(key.slice(0, -3) + "y") : undefined);
};
const VERBS: Record<string, string> = {
  new: "create", create: "create", get: "retrieve", retrieve: "retrieve", update: "update", list: "list", del: "del", delete: "del",
  cancel: "cancel", confirm: "confirm", capture: "capture", search: "search", expire: "expire", attach: "attach", detach: "detach",
  finalizeinvoice: "finalize_invoice", pay: "pay", voidinvoice: "void_invoice", sendinvoice: "send_invoice", reject: "reject", close: "close",
};
export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
const blank = (l: string) => l.replace(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g, (m) => " ".repeat(m.length));

type Field = { key: string; line: number; start: number; end: number };

/** Fields of a block opening at (row, col): `Name:` (Go), `Name =` (C#), at the top level only */
export function blockFields(lines: string[], starts: number[], row: number, col: number, re: RegExp, toKey: (s: string) => string): Field[] {
  const out: Field[] = [];
  let depth = 0;
  for (let r = row; r < Math.min(lines.length, row + 300); r++) {
    const l = lines[r];
    const b = blank(l);
    const from = r === row ? col : 0;
    const depthAt: number[] = [];
    let done = false;
    for (let j = from; j < b.length; j++) {
      depthAt[j] = depth;
      const c = b[j];
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") {
        depth--;
        if (depth === 0) {
          done = true;
          break;
        }
      }
    }
    for (const m of l.matchAll(re)) {
      const at = m.index! + m[0].indexOf(m[1]);
      if (at >= from && depthAt[at] === 1) out.push({ key: toKey(m[1]), line: r + 1, start: starts[r] + at, end: starts[r] + l.length });
    }
    if (done) break;
  }
  return out;
}

/** Java builder calls from (row, col) to `.build()`: .setFooBar(…) → foo_bar, .addFooBar(…) → foo_bars, .putMetadata → metadata */
function builderFields(lines: string[], starts: number[], row: number, col: number): Field[] {
  const out: Field[] = [];
  for (let r = row; r < Math.min(lines.length, row + 80); r++) {
    const l = lines[r];
    const from = r === row ? col : 0;
    for (const m of l.slice(from).matchAll(/\.(set|add|addAll|put|putAll)([A-Z]\w*)\s*\(/g)) {
      const base = snake(m[2]);
      const key = m[1] === "add" ? (base.endsWith("s") ? base : base + "s") : base;
      out.push({ key, line: r + 1, start: starts[r] + from + m.index!, end: starts[r] + l.length });
    }
    if (/\.build\s*\(\s*\)/.test(l.slice(from))) break;
  }
  return out;
}

/** Where a local named `name` gets its value in the lines before `row` (same function, roughly) */
function bindingRow(lines: string[], name: string, row: number): { row: number; col: number } | undefined {
  const re = new RegExp(`(?:^|[\\s(,])(?:var\\s+|final\\s+|[\\w<>.\\[\\]]+\\s+)?${name}\\s*(?::=|=)\\s*`);
  for (let r = row; r >= Math.max(0, row - MAX_BACK); r--) {
    const m = re.exec(lines[r]);
    if (m) return { row: r, col: m.index + m[0].length };
  }
  return undefined;
}

export function typedSdkUsages(file: string, lang: Usage["lang"], source: string): Usage[] {
  if (!["go", "java", "cs", "py"].includes(lang) || source.length > 2_000_000) return [];
  if (lang === "py") {
    // Python SDK calls go through the syntax-tree analyzer; here only the typed request dicts (v11)
    if (!/stripe\.(?:params\.)?[\w.]*Params\b/.test(source)) return [];
    const ls = source.split("\n");
    const st: number[] = [];
    let a = 0;
    for (const l of ls) {
      st.push(a);
      a += l.length + 1;
    }
    return typedParams(file, lang, ls, st, source);
  }
  const p = providerById("stripe");
  if (!p?.opFor) return [];
  const imports = lang === "go" ? /stripe-go/.test(source) : lang === "java" ? /\bcom\.stripe\b/.test(source) : /\busing\s+Stripe\b|\bStripe\.\w+Service\b|StripeClient/.test(source);
  if (!imports) return [];
  const lines = source.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  // Go: import aliases for resource packages (…/stripe-go/v81/paymentintent, …/checkout/session)
  const goPkgs = new Map<string, string>();
  if (lang === "go") {
    for (const m of source.matchAll(/(?:^|\s)(\w+\s+)?"github\.com\/stripe\/stripe-go\/v\d+\/([\w/]+)"/g)) {
      const segs = m[2].split("/");
      goPkgs.set(m[1]?.trim() || segs[segs.length - 1], segs.join(""));
    }
  }
  // Java: imported model classes (com.stripe.model.PaymentIntent, com.stripe.model.checkout.Session)
  const javaClasses = new Map<string, string>();
  if (lang === "java") for (const m of source.matchAll(/import\s+com\.stripe\.model\.((?:\w+\.)*)([A-Z]\w*)\s*;/g)) javaClasses.set(m[2], m[1].replace(/\./g, "") + m[2]);
  // C#: service locals (var service = new PaymentIntentService();)
  const csServices = new Map<string, string>();
  if (lang === "cs") {
    for (const m of source.matchAll(/\b(?:var|[\w.]+Service)\s+(\w+)\s*=\s*new\s+(?:Stripe\.)?((?:\w+\.)*\w+)Service\s*\(/g)) csServices.set(m[1], m[2]);
    // var service = client.V1.PaymentIntents;
    for (const m of source.matchAll(/\b(?:var|[\w.]+Service)\s+(\w+)\s*=\s*\w+\.V\d+\.((?:[A-Z]\w*\.)*[A-Z]\w*)\s*;/g)) csServices.set(m[1], m[2]);
  }

  const out: Usage[] = [];
  lines.forEach((l, i) => {
    if (l.length > MAX_LINE || /^\s*(\/\/|\*)/.test(l)) return;
    const calls: { res: string; verb: string; end: number }[] = [];
    if (lang === "go") {
      for (const m of l.matchAll(/\b(\w+)\.(New|Get|Update|List|Del|Cancel|Confirm|Capture|Search|Expire)\s*\(/g)) if (goPkgs.has(m[1])) calls.push({ res: goPkgs.get(m[1])!, verb: m[2], end: m.index! + m[0].length });
      for (const m of l.matchAll(/\.V\d+((?:[A-Z][a-z0-9]*)+)\.(\w+)\s*\(/g)) calls.push({ res: m[1], verb: m[2], end: m.index! + m[0].length });
    } else if (lang === "java") {
      for (const m of l.matchAll(/(?<![\w.])([A-Z]\w*)\.(create|retrieve|update|list|delete|cancel|confirm|capture|search|expire)\s*\(/g)) if (javaClasses.has(m[1])) calls.push({ res: javaClasses.get(m[1])!, verb: m[2], end: m.index! + m[0].length });
      for (const m of l.matchAll(/\b\w+\s*\.\s*(?:v\d+\(\)\s*\.\s*)?((?:[a-z]\w*\(\)\s*\.\s*)+)(create|retrieve|update|list|delete|cancel|confirm|capture|search|expire)\s*\(/g)) {
        const res = m[1].replace(/\(\)\s*\.\s*/g, ".").replace(/\.$/, "");
        if (/\b(StripeClient|client|stripe)\b/i.test(l.slice(0, m.index! + 20))) calls.push({ res, verb: m[2], end: m.index! + m[0].length });
      }
    } else {
      for (const m of l.matchAll(/\bnew\s+(?:Stripe\.)?((?:\w+\.)*\w+)Service\s*\([^)]*\)\s*\.\s*(\w+?)(?:Async)?\s*\(/g)) calls.push({ res: m[1], verb: m[2], end: m.index! + m[0].length });
      for (const m of l.matchAll(/\b(\w+)\s*\.\s*(\w+?)(?:Async)?\s*\(/g)) if (csServices.has(m[1])) calls.push({ res: csServices.get(m[1])!, verb: m[2], end: m.index! + m[0].length });
      for (const m of l.matchAll(/\.V\d+\.((?:[A-Z]\w*\.)+)(\w+?)(?:Async)?\s*\(/g)) calls.push({ res: m[1].replace(/\.$/, ""), verb: m[2], end: m.index! + m[0].length });
    }
    for (const c of calls) {
      const res = resourceOf("stripe", c.res);
      const verb = VERBS[c.verb.toLowerCase()];
      if (!res || !verb) continue;
      const op = sdkOp(p, `${res}.${verb}`);
      if (!op) continue;
      // The request: the first argument (Go: after ctx), inline or a local built earlier
      const argsText = l.slice(c.end);
      const args = argsText.split(",").map((s) => s.trim());
      const arg = lang === "go" && /^ctx\b|^context\./.test(args[0] ?? "") ? args[1] ?? "" : args[0] ?? "";
      let fields: Field[] = [];
      const inlineAt = (re: RegExp) => {
        const m = re.exec(argsText);
        return m ? c.end + m.index + m[0].length - 1 : -1;
      };
      if (lang === "go") {
        const col = inlineAt(/&?stripe\.\w+Params\s*\{/);
        if (col >= 0) fields = blockFields(lines, starts, i, col, /\b([A-Z]\w*)\s*:(?!=)/g, snake);
        else {
          const name = /^&?(\w+)/.exec(arg)?.[1];
          const b = name ? bindingRow(lines, name, i) : undefined;
          const open = b ? /&?stripe\.\w+Params\s*\{/.exec(lines[b.row].slice(b.col)) : undefined;
          if (b && open) fields = blockFields(lines, starts, b.row, b.col + open.index + open[0].length - 1, /\b([A-Z]\w*)\s*:(?!=)/g, snake);
        }
      } else if (lang === "java") {
        if (/\.builder\(\)/.test(argsText)) fields = builderFields(lines, starts, i, c.end);
        else {
          const name = /^(\w+)/.exec(arg)?.[1];
          const b = name ? bindingRow(lines, name, i) : undefined;
          if (b && /\.builder\(\)/.test(lines.slice(b.row, b.row + 3).join(" "))) fields = builderFields(lines, starts, b.row, b.col);
          // v11: Map<String, Object> params = new HashMap<>(); params.put("payment_method_types", …); Session.create(params, opts)
          else if (b && name && /new\s+(?:Linked)?HashMap\b|Map\.of\(|new\s+TreeMap\b/.test(lines[b.row])) {
            for (let r = b.row; r < i; r++) {
              for (const m of lines[r].matchAll(new RegExp(`\\b${name}\\.put\\(\\s*"([a-z_]\\w*)"`, "g"))) fields.push({ key: m[1], line: r + 1, start: starts[r] + m.index!, end: starts[r] + lines[r].length });
            }
            for (const m of lines[b.row].matchAll(/Map\.of\(|"([a-z_]\w*)"\s*,/g)) if (m[1]) fields.push({ key: m[1], line: b.row + 1, start: starts[b.row] + m.index!, end: starts[b.row] + lines[b.row].length });
          }
        }
      } else {
        const col = inlineAt(/new\s+[\w.]*Options\s*\{/);
        if (col >= 0) fields = blockFields(lines, starts, i, col, /\b([A-Z]\w*)\s*=(?!=)/g, snake);
        else {
          const name = /^(\w+)/.exec(arg)?.[1];
          const b = name ? bindingRow(lines, name, i) : undefined;
          const text = b ? lines.slice(b.row, b.row + 2).join("\n") : "";
          const open = b ? /new\s+[\w.]*Options\s*(\(\s*\))?\s*\{?/.exec(lines[b.row].slice(b.col)) : undefined;
          if (b && open) {
            // The brace may be on the next line
            let row = b.row;
            let col2 = b.col + open.index + open[0].length - 1;
            if (!open[0].endsWith("{")) {
              const nb = lines[b.row + 1]?.indexOf("{") ?? -1;
              if (nb >= 0 && /^\s*\{/.test(lines[b.row + 1])) (row = b.row + 1), (col2 = nb);
              else col2 = -1;
            }
            if (col2 >= 0 && text) fields = blockFields(lines, starts, row, col2, /\b([A-Z]\w*)\s*=(?!=)/g, snake);
          }
        }
      }
      // v11: fields set after the request is built (Go params.PaymentMethodTypes = …, C# options.PaymentMethodTypes = …)
      const local = lang !== "java" ? /^&?(\w+)\s*[,)]?/.exec(arg)?.[1] : undefined;
      if (local) {
        const from = bindingRow(lines, local, i)?.row ?? Math.max(0, i - MAX_BACK);
        for (let r = from; r < i; r++) {
          for (const m of lines[r].matchAll(new RegExp(`\\b${local}\\.([A-Z]\\w*)\\s*=(?!=)`, "g"))) {
            const key = snake(m[1]);
            if (!fields.some((f) => f.key === key)) fields.push({ key, line: r + 1, start: starts[r] + m.index!, end: starts[r] + lines[r].length });
          }
        }
      }
      const direct = fields.length > 0 && fields.every((f) => f.line === i + 1);
      out.push({ provider: "stripe", kind: "sdk", lang, file, line: i + 1, op, sdkCall: `${res}.${verb}`, params: direct ? fields.map((f) => f.key) : [], confidence: "likely", snippet: l.trim().slice(0, 200) });
      if (!direct) {
        for (const f of fields) {
          out.push({
            provider: "stripe", kind: "sdk", lang, file, line: f.line, op, sdkCall: `${res}.${verb}`, params: [f.key], confidence: "likely",
            snippet: (lines[f.line - 1] ?? "").trim().slice(0, 200), reason: "a field of the request passed to this call", paramSpans: { [f.key]: { start: f.start, end: f.end } },
          });
        }
      }
    }
  });
  // v11: typed params objects name their operation, wherever they're passed (the app's own adapters included)
  // (the same field already read from the call, on its line; another request object setting it is another place)
  const seen = new Set(out.filter((u) => u.params?.length).flatMap((u) => u.params!.map((k) => `${u.op}|${k}|${u.line}`)));
  for (const u of typedParams(file, lang, lines, starts, source)) {
    const k = `${u.op}|${u.params![0]}|${u.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

const PARAM_VERB: Record<string, string> = { create: "create", update: "update", modify: "update", list: "list", get: "retrieve", retrieve: "retrieve", cancel: "cancel", confirm: "confirm", capture: "capture", search: "search", delete: "del" };

/**
 * v11: Stripe's typed request objects, read where they're built:
 *   C#      new SetupIntentCreateOptions { PaymentMethodTypes = … }   (Stripe.net *CreateOptions / *UpdateOptions …)
 *   Go      params := &stripe.CheckoutSessionParams{}; params.PaymentMethodTypes = …   (stripe-go *Params)
 *   Java    SessionCreateParams.builder().addPaymentMethodType(…)   (stripe-java *CreateParams)
 *   Python  params: stripe.SetupIntent.CreateParams = { … }   (stripe-python typed dicts)
 * The class name gives the operation; the initializer and later assignments to the same variable give the params.
 */
function typedParams(file: string, lang: Usage["lang"], lines: string[], starts: number[], source: string): Usage[] {
  const p = providerById("stripe")!;
  const out: Usage[] = [];
  const emit = (resName: string, verbName: string, fields: Field[], why: string) => {
    const res = resourceOf("stripe", resName);
    const verb = PARAM_VERB[verbName.toLowerCase()] ?? "create";
    if (!res) return;
    const op = sdkOp(p, `${res}.${verb}`);
    if (!op) return;
    for (const f of fields) {
      out.push({
        provider: "stripe", kind: "sdk", lang, file, line: f.line, op, sdkCall: `${res}.${verb}`, params: [f.key], confidence: "likely",
        snippet: (lines[f.line - 1] ?? "").trim().slice(0, 200), reason: why, paramSpans: { [f.key]: { start: f.start, end: f.end } },
      });
    }
  };
  // Later assignments to the variable: name.Field = … (C#, Go), name["k"] = … (Python), name.put("k", …) (Java maps)
  const later = (name: string, row: number, re: (n: string) => RegExp, toKey: (s: string) => string): Field[] => {
    const f: Field[] = [];
    for (let r = row + 1; r < Math.min(lines.length, row + MAX_BACK); r++) {
      if (new RegExp(`\\b${name}\\s*(?::=|=)\\s*(?:&|new\\b|stripe\\.)`).test(lines[r])) break;
      for (const m of lines[r].matchAll(re(name))) f.push({ key: toKey(m[1]), line: r + 1, start: starts[r] + m.index!, end: starts[r] + lines[r].length });
    }
    return f;
  };
  if (lang === "cs" && /\bStripe\b/.test(source)) {
    const ns = /\bStripe\.BillingPortal\b|using\s+Stripe\.BillingPortal/.test(source) ? "billingportal" : /\bStripe\.Checkout\b|using\s+Stripe\.Checkout/.test(source) ? "checkout" : "";
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/(?:\b(?:var|[\w.]+Options)\s+(\w+)\s*=\s*)?new\s+(?:Stripe\.)?((?:\w+\.)*)(\w+?)(Create|Update|List|Get|Cancel|Confirm|Capture|Search|Delete)Options\b\s*(\(\s*\))?\s*(\{)?/g)) {
        const nsHere = m[2].replace(/\./g, "").toLowerCase();
        const res = (nsHere || (m[3] === "Session" ? ns || "checkout" : "")) + m[3];
        let fields: Field[] = [];
        const brace = m[6] ? { row: i, col: m.index! + m[0].length - 1 } : /^\s*\{/.test(lines[i + 1] ?? "") ? { row: i + 1, col: lines[i + 1].indexOf("{") } : undefined;
        if (brace) fields = blockFields(lines, starts, brace.row, brace.col, /\b([A-Z]\w*)\s*=(?!=)/g, snake);
        if (m[1]) fields.push(...later(m[1], i, (n) => new RegExp(`\\b${n}\\.([A-Z]\\w*)\\s*=(?!=)`, "g"), snake));
        emit(res, m[4], fields, "a field of a typed Stripe request (options object)");
      }
      // v13: target-typed new (C# 9+): SetupIntentCreateOptions options = new() { … } / new() on the next line
      for (const m of l.matchAll(/\b(?:Stripe\.)?((?:\w+\.)*)(\w+?)(Create|Update|List|Get|Cancel|Confirm|Capture|Search|Delete)Options\??\s+(\w+)\s*=\s*new\s*\(\s*\)\s*(\{)?/g)) {
        const nsHere = m[1].replace(/\./g, "").toLowerCase();
        const res = (nsHere || (m[2] === "Session" ? ns || "checkout" : "")) + m[2];
        const brace = m[5] ? { row: i, col: m.index! + m[0].length - 1 } : /^\s*\{/.test(lines[i + 1] ?? "") ? { row: i + 1, col: lines[i + 1].indexOf("{") } : undefined;
        const fields = brace ? blockFields(lines, starts, brace.row, brace.col, /\b([A-Z]\w*)\s*=(?!=)/g, snake) : [];
        fields.push(...later(m[4], i, (n) => new RegExp(`\\b${n}\\.([A-Z]\\w*)\\s*=(?!=)`, "g"), snake));
        emit(res, m[3], fields, "a field of a typed Stripe request (options object)");
      }
    });
  } else if (lang === "go" && /stripe-go/.test(source)) {
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/(?:\b(\w+)\s*:?=\s*)?&?stripe\.(\w+?)(Create|Update|List|Retrieve|Cancel|Confirm|Capture|Search)?Params\s*\{/g)) {
        let fields = blockFields(lines, starts, i, m.index! + m[0].length - 1, /\b([A-Z]\w*)\s*:(?!=)/g, snake);
        if (m[1]) fields = [...fields, ...later(m[1], i, (n) => new RegExp(`\\b${n}\\.([A-Z]\\w*)\\s*=(?!=)`, "g"), snake)];
        // The verb: the type's own (…CreateParams), else the call it's handed to (paymentintent.Update(id, params)), else create
        let verb = m[3] ?? "create";
        if (!m[3] && m[1]) {
          const call = lines.slice(i, i + MAX_BACK).join("\n").match(new RegExp(`\\.(New|Update|List|Get|Cancel|Confirm|Capture|Del|Search)\\s*\\([^)]*\\b${m[1]}\\b`));
          if (call) verb = call[1] === "New" ? "create" : call[1] === "Get" ? "retrieve" : call[1] === "Del" ? "delete" : call[1];
        }
        emit(m[2], verb, fields, "a field of a typed Stripe request (params struct)");
      }
    });
  } else if (lang === "java" && /\bcom\.stripe\b/.test(source)) {
    const nsOf = new Map<string, string>();
    for (const m of source.matchAll(/import\s+com\.stripe\.param\.((?:\w+\.)*)(\w+?)(Create|Update|List|Retrieve|Cancel|Confirm|Capture|Search)Params\s*;/g)) nsOf.set(m[2] + m[3], m[1].replace(/\./g, ""));
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/\b(\w+?)(Create|Update|List|Retrieve|Cancel|Confirm|Capture|Search)Params\s*\.\s*builder\s*\(\s*\)/g)) {
        emit((nsOf.get(m[1] + m[2]) ?? "") + m[1], m[2], builderFields(lines, starts, i, m.index!), "a field of a typed Stripe request (params builder)");
      }
    });
  } else if (lang === "py" && /\bstripe\b/.test(source)) {
    lines.forEach((l, i) => {
      // params: stripe.SetupIntent.CreateParams = {…} / params: "stripe.checkout.Session.CreateParams" = {…} / stripe.params.PaymentIntentCreateParams
      const m = /^\s*(\w+)\s*:\s*["']?stripe\.(?:params\.)?((?:[a-z_]+\.)*)([A-Z]\w*?)\.?(Create|Modify|Update|List|Retrieve|Cancel|Confirm|Capture|Search)Params["']?\s*=\s*\{/.exec(l);
      if (!m) return;
      const fields = blockFields(lines, starts, i, m[0].length - 1, /["']([a-z_]\w*)["']\s*:/g, (s) => s);
      fields.push(...later(m[1], i, (n) => new RegExp(`\\b${n}\\[\\s*["']([a-z_]\\w*)["']\\s*\\]\\s*=(?!=)`, "g"), (s) => s));
      emit(m[2].replace(/\./g, "") + m[3], m[4], fields, "a field of a typed Stripe request (typed dict)");
    });
  }
  return out;
}
