/**
 * A provider SDK's own code in the repo with no manifest of its own (Review: a built client
 * app's numbered bundle modules, engine/modules/0412-assistants.js, holding the OpenAI JS SDK's resource classes).
 * What marks SDK code is what it defines, not where it sits, nor what it's named: a minified, re-split bundle has
 * mangled class names (iCe = class iCe extends Ni { … }) and tagged-template paths (this._client.post(Cn`/threads/…`)).
 * Any language, never by path or name:
 *   - a resource class: class Assistants extends APIResource (JS/TS), class Assistants(SyncAPIResource) (Python),
 *     func (r *AssistantService) New(ctx context.Context, … (Go, with requestconfig)
 *   - a request through the SDK's client internals that passes the generator's own request options (__security,
 *     __synthesizeEventData, __binaryResponse, __metadata): those keys exist only inside generated SDKs
 *   - two or more requests through the client internals (this._client.post(…), self._post("/…")) with a sub-resource
 *     built on the same client (new X(this._client)) or the generated SDK's own markers (APIPromise, PagePromise,
 *     APIResource, X-Stainless-…)
 * Calls to an SDK (client.beta.assistants.create(…)) are never this: they don't define the resources.
 */
const RESOURCE_CLASS = [
    /\bclass\s+[A-Z]\w*\s+extends\s+(?:[\w$]+\.)?(?:API)?Resource\b/,
    /\bclass\s+[A-Z]\w*\s*\(\s*(?:Sync|Async)?APIResource\s*\)\s*:/,
    /\bfunc\s+\(\s*\w+\s+\*\w+Service\)\s+\w+\(\s*ctx\s+context\.Context[^)]*\)[\s\S]{0,400}?\brequestconfig\./,
];
// a request through the client internals, whatever the path's form: '/x', `/x/${id}`, a tagged template Cn`/x`
const CLIENT_INTERNAL = /\bthis\._client\.(?:get|post|put|patch|delete|getAPIList|requestAPIList)\(\s*(?:[\w$]+\s*)?[`'"]\/|\bself\._(?:get|post|put|patch|delete|get_api_list)\(\s*f?["']\//g;
const GENERATOR_OPTION = /\b__(?:security|synthesizeEventData|binaryResponse|metadata)\s*:/;
const SUB_RESOURCE = /\bnew\s+[\w$]+\(\s*this\._client\s*\)/;
const SDK_MARKER = /\bAPIPromise\b|\bPagePromise\b|\bAPIResource\b|X-Stainless-|\bstainless\b/i;
export function isSdkSource(source) {
    if (source.length > 2_000_000)
        return false;
    if (RESOURCE_CLASS.some((r) => r.test(source)))
        return true;
    let n = 0;
    for (const _ of source.matchAll(CLIENT_INTERNAL))
        if (++n >= 2)
            break;
    if (!n)
        return false;
    if (GENERATOR_OPTION.test(source))
        return true;
    return n >= 2 && (SUB_RESOURCE.test(source) || SDK_MARKER.test(source));
}
