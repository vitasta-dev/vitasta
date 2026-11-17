import Stripe from "stripe";
import twilio from "twilio";
import { Octokit } from "@octokit/rest";
import { shopifyApi, ApiVersion } from "@shopify/shopify-api";

const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: "2023-10-16" });
const sms = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const gh = new Octokit({ auth: process.env.GH_TOKEN });
const shopify = shopifyApi({ apiKey: "k", apiSecretKey: "s", apiVersion: ApiVersion.July25, hostName: "x" });

export async function checkout() {
  await stripe.checkout.sessions.create({ mode: "payment", payment_method_types: ["card"], line_items: [] });
  await stripe.paymentIntents.retrieve("pi_123");
  await sms.messages.create({ to: "+1", from: "+1", body: "hi" });
  await gh.rest.repos.get({ owner: "acme", repo: "app" });
  await gh.request("GET /classrooms");
  return fetch("https://acme.myshopify.com/admin/api/2025-04/orders.json");
}

export const fbPost = (id: string) => fetch(`https://graph.facebook.com/v21.0/${id}/feed`, { method: "POST" });
