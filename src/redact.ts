/**
 * Remove secrets from anything Vitasta prints, posts or logs. Snippets are one line of the customer's code, and
 * code sometimes holds a hard-coded key: Vitasta must never copy one into a report, an issue or a log.
 *
 * Covers the providers Vitasta tracks plus common cloud and chat tokens, and any quoted value assigned to a
 * name that looks like a secret. Keeps a short prefix so the reader can tell which key it was.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, // OpenAI
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{8,}/g, // Stripe webhook secret
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{16,}/g, // Shopify
  /\bEAA[A-Za-z0-9]{30,}/g, // Meta access token
  /\bSK[0-9a-f]{32}\b/g, // Twilio API key
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bxai-[A-Za-z0-9]{20,}/g, // xAI
  /\bAccountKey=[A-Za-z0-9+/=]{20,}/g, // Azure storage connection string
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  // Added after the 18 Nov review (F11)
  /\bpplx-[A-Za-z0-9]{20,}/g, // Perplexity
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/g, // SendGrid
  /\bxapp-\d-[A-Za-z0-9-]{20,}/g, // Slack app-level token
  /hooks\.slack\.com\/services\/[\w/]+/g, // Slack incoming webhook
  /\bntn_\w{20,}/g, // Notion
  /\bsecret_\w{30,}/g, // Notion (older)
  /\bpat-(?:na|eu)\d-[0-9a-f-]{36}/g, // HubSpot
  /\br8_\w{20,}/g, // Replicate
  /\bGOCSPX-[\w-]{20,}/g, // Google OAuth client secret
  /\bfw_\w{20,}/g, // Fireworks
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm
  // A long random literal handed straight to a client or credential: Cohere("…"), AzureKeyCredential("…")
  /(?<=\b\w*(?:Client|Credential|Key|Token)\(\s*["'`])[A-Za-z0-9+/=_-]{24,}(?=["'`])/g,
];

/** Authorization headers and basic-auth in URLs */
const AUTH_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@"],
];

/** password = "…", api_key: '…', "clientSecret": "…" */
const SECRET_ASSIGN = /(\b[\w-]*(?:secret|passw(?:or)?d|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|access[_-]?token|api[_-]?token|\btoken|private[_-]?key|credential)[\w-]*["']?\]?\s*[:=]\s*[bBrRuUfF]?)(["'`])([^"'`\n]{6,200})\2/gi;

function mask(s: string): string {
  return `${s.slice(0, Math.min(6, Math.floor(s.length / 4)))}…[redacted]`;
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, (m) => mask(m));
  for (const [re, rep] of AUTH_PATTERNS) out = out.replace(re, rep);
  out = out.replace(SECRET_ASSIGN, (_m, pre: string, q: string, val: string) => `${pre}${q}${/\[redacted\]/.test(val) ? val : mask(val)}${q}`);
  return out;
}
