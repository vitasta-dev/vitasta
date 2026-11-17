import { Client } from "@notionhq/client";

export const notion = new Client({ auth: process.env.NOTION_TOKEN, notionVersion: "2022-06-28" });

export async function retrieve(token: string) {
  return fetch("https://graph.microsoft.com/v1.0/copilot/retrieval", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}

export async function categories(account: string, id: string) {
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/cloudforce-one/events/categories/${id}`);
}
