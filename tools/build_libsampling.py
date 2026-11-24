# Build the scanner's src/data/library-sampling.json from the feed's library maps (data/_*-sampling.json):
# one normalised shape per library: ranges {from, to, sends (settings the release sends when the app sets none, with
# values), dropsFor (model id prefixes it sends none of them for), dropsWhenThinking, gate (litellm: models it
# raises a client-side error for unless drop_params, or drops with it)}.
import json, os, sys
FEED = os.path.expanduser("~/vitasta/feed/data")
out = {"_about": "What wrapper libraries do with an app's temperature / top_p / top_k for Anthropic, by release; built from the feed's library maps (data/_langchain-anthropic-sampling.json, _langchain-anthropic-py-sampling.json, _rubyllm-anthropic-sampling.json, _litellm-anthropic-sampling.json, _springai-anthropic-sampling.json), read from each release's published package. Regenerate with tools/build_libsampling.py; don't edit by hand.", "libraries": []}
def load(n): return json.load(open(os.path.join(FEED, n)))
WIRE = {"temperature": "temperature", "topK": "top_k", "topP": "top_p", "top_k": "top_k", "top_p": "top_p"}
lc = load("_langchain-anthropic-sampling.json")
out["libraries"].append({
  "package": "@langchain/anthropic", "ecosystem": "npm", "lang": ["ts", "js"],
  "uses": ["\\bnew\\s+ChatAnthropic(?:Messages)?\\s*\\("], "anthropicOnly": True,
  "ranges": [{"from": r["from"], "to": r["to"], "sends": ({WIRE[k]: v for k, v in r["defaults"].items() if v is not None} if r["sendsDefaults"] else {}),
              "dropsFor": r["dropsForPrefixes"], "dropsWhenThinking": r["dropsWhenThinking"]} for r in lc["ranges"]]})
py = load("_langchain-anthropic-py-sampling.json")
out["libraries"].append({
  "package": "langchain-anthropic", "ecosystem": "pypi", "lang": ["py"],
  "uses": ["\\bChatAnthropic\\s*\\(", "\\binit_chat_model\\s*\\(\\s*(?:model\\s*=\\s*)?[\"'](?:anthropic:|claude)", "\\binit_chat_model\\s*\\([^)]*model_provider\\s*=\\s*[\"']anthropic"], "anthropicOnly": True,
  "ranges": [{"from": r["from"], "to": r["to"], "sends": {}, "dropsFor": r["dropsForPrefixes"], "dropsWhenThinking": False} for r in py["ranges"]]})
rb = load("_rubyllm-anthropic-sampling.json")
out["libraries"].append({
  "package": "ruby_llm", "ecosystem": "gem", "lang": ["rb"],
  "uses": ["\\bRubyLLM\\.chat\\b", "\\bRubyLLM::Chat\\.new\\b"], "anthropicOnly": False,
  "ranges": [{"from": r["from"], "to": r["to"], "sends": r["sendsWhenUnset"], "dropsFor": [], "dropsWhenThinking": False} for r in rb["ranges"]]})
ll = load("_litellm-anthropic-sampling.json")
rs = []
for r in ll["ranges"]:
    g = None
    if r["modelGate"]:
        ids = sorted({i for v in r["modelMapNoSampling"].values() for i in v})
        g = {"names": r["nameFallback"], "ids": ids, "onUnsupported": r["onUnsupported"], "temperatureOne": r["temperatureOneAllowed"]}
    rs.append({"from": r["from"], "to": r["to"], "sends": {}, "dropsFor": [], "dropsWhenThinking": False, "gate": g})
out["libraries"].append({
  "package": "litellm", "ecosystem": "pypi", "lang": ["py"],
  "uses": ["\\blitellm\\.a?completion\\s*\\(", "^\\s*(?:response\\s*=\\s*)?(?:await\\s+)?a?completion\\s*\\("], "anthropicOnly": False, "dropParams": "drop_params\\s*=\\s*True",
  "ranges": rs})
sa = load("_springai-anthropic-sampling.json")
out["libraries"].append({
  "package": "org.springframework.ai:spring-ai-anthropic", "ecosystem": "maven", "lang": ["java"], "versionGroup": "org.springframework.ai",
  "uses": ["\\bAnthropicChatOptions\\s*\\.\\s*builder\\s*\\("], "anthropicOnly": True,
  "ranges": [{"from": r["from"], "to": r["to"], "sends": {}, "dropsFor": [], "dropsWhenThinking": False, **({} if r["sendsAppSet"] else {"dropsAll": True})} for r in sa["ranges"]]})
json.dump(out, open(sys.argv[1], "w"), indent=1); open(sys.argv[1], "a").write("\n")
for l in out["libraries"]: print(l["package"], len(l["ranges"]), "ranges")
