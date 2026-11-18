/**
 * A test on a name: substrings (pric matches PRICES and pricing), plus whole words of the name, split at _, -, . and
 * camelCase (demo matches DEMO_MODELS and demoModels, not ClaudeModel). Also takes free text (a line before a value).
 */
export function nameMatcher(substrings: RegExp, words: string[]): { test(name: string): boolean } {
  const w = new RegExp(`_(${words.join("|")})(s|es|ed|ing)?_`);
  return {
    test(name: string) {
      if (substrings.test(name)) return true;
      const segs = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return w.test(`_${segs.join("_")}_`);
    },
  };
}
