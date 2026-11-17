export async function me(deps: { fetch: typeof fetch }, token: string) {
  const res = await deps.fetch(`https://graph.facebook.com/v19.0/me?access_token=${token}`);
  return res.json();
}
export const webhooks = (shopDomain: string) => `https://${shopDomain}/admin/api/2026-04/webhooks.json`;
export const ads = { baseURL: "https://googleads.googleapis.com/v24" };
export const docsLink = "https://developers.facebook.com/docs/graph-api/changelog/version18.0";
