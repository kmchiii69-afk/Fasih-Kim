// api/fathom-webhook.js
// Fathom "new meeting content ready" webhook -> Claude extraction -> Discord.
// Fires automatically when a NEW call finishes. (For old calls, use backfill.js.)
//
// Env vars (Vercel project settings):
//   FATHOM_WEBHOOK_SECRET   whsec_...  (given when you create the webhook)
//   ANTHROPIC_API_KEY       sk-ant-...
//   DISCORD_WEBHOOK_URL     https://discord.com/api/webhooks/...

import crypto from "crypto";
import { processMeeting, postToDiscord } from "./_lib.js";

// We need the RAW body for signature verification, so disable Vercel's parser.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifyFathomWebhook(secret, headers, rawBody) {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sigHeader = headers["webhook-signature"];
  if (!id || !ts || !sigHeader) return false;

  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10)) > 300) {
    return false;
  }

  const signedContent = `${id}.${ts}.${rawBody}`;
  const secretBytes = Buffer.from(secret.split("_")[1], "base64");
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  const provided = sigHeader.split(" ").map((s) => {
    const parts = s.split(",");
    return parts.length > 1 ? parts[1] : parts[0];
  });

  return provided.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    } catch {
      return false;
    }
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: "Could not read body" });
  }

  if (process.env.SKIP_VERIFY !== "true") {
    const ok = verifyFathomWebhook(
      process.env.FATHOM_WEBHOOK_SECRET,
      req.headers,
      rawBody
    );
    if (!ok) return res.status(401).json({ error: "Invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  try {
    await processMeeting(payload);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Processing error:", err);
    try {
      await postToDiscord({
        content: `⚠️ Fathom call summary failed to process: ${String(err).slice(0, 300)}`,
      });
    } catch {}
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
