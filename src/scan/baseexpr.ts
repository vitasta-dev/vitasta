/**
 * A client base URL built from configuration plus a version path:
 *   OpenAI(base_url=f"{self.config['gateway_url']}/v1"), base_url=settings.GATEWAY + "/v1",
 *   base_url="{}/v1".format(cfg.host), baseURL: `${process.env.GATEWAY}/v1`
 * The host comes from the app's own settings and the code adds the API's version path itself: a server the app
 * configures (its gateway), not the provider. A value that names a provider host anywhere isn't this case, and
 * neither is a plain env or config value with no path added (base_url=os.getenv("OPENAI_BASE_URL") usually falls back
 * to the provider). Returns a label for the proxy ("configured gateway_url"), or undefined.
 */
const VERSION_TAIL = String.raw`\/v\d+(?:beta)?\/?`;
const F_STRING = new RegExp(String.raw`^[rR]?[fF](["'])\{([^{}]+)\}${VERSION_TAIL}\1$`);
const TEMPLATE = new RegExp(String.raw`^\x60\$\{([^{}]+)\}${VERSION_TAIL}\x60$`);
const CONCAT = new RegExp(String.raw`^([\w.\[\]'"()]+)\s*\+\s*(["'])${VERSION_TAIL}\2$`);
const FORMAT = new RegExp(String.raw`^(["'])\{\}${VERSION_TAIL}\1\.format\(\s*([^()]+?)\s*\)$`);

export function configuredBase(expr: string, providerHosts: string[]): string | undefined {
  const e = expr.trim();
  if (/https?:\/\//.test(e) || providerHosts.some((h) => e.includes(h))) return undefined;
  const inner = F_STRING.exec(e)?.[2] ?? TEMPLATE.exec(e)?.[1] ?? CONCAT.exec(e)?.[1] ?? FORMAT.exec(e)?.[2];
  if (!inner) return undefined;
  // the name of the setting: the last word or quoted key (self.config['gateway_url'] → gateway_url)
  const name = [...inner.matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]).filter((w) => !/^(?:self|this|os|environ|getenv|get|config|settings|process|env|cfg|conf)$/.test(w)).pop() ?? inner.replace(/[^\w.]/g, "").slice(0, 40);
  return `configured ${name}`;
}
