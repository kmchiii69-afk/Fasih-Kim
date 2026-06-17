// api/fathom-webhook.js
// Fathom "new meeting content ready" webhook -> Claude extraction -> Discord.
// Fires automatically when a NEW call finishes. (For old calls, use backfill.js.)
//
// Env vars (Vercel project settings):
//   FATHOM_WEBHOOK_SECRET   whsec_...  (given when you create the webhook)
//   ANTHROPIC_API_KEY       sk-ant-...
//   DISCORD_WEBHOOK_URL     https://discord.com/api/webhooks/...

import crypto from "crypto";
import { processMeeting, postToDiscord, fetchMeetingById } from "./_lib.js";

// We need the RAW body for signature verification, so disable Vercel's parser.
export const config = { api: { bodyParser: false } };

// In-memory dedupe: remembers recording ids this warm instance has already
// handled, so a Fathom retry (which arrives within seconds/minutes) won't post
// a second time. Entries expire after 30 min to keep the map small. This lives
// in module scope, which persists across invocations while the instance is warm.
const RECENTLY_HANDLED = new Map(); // recordingId -> timestamp(ms)
const DEDUPE_TTL_MS = 30 * 60 * 1000;

function alreadyHandled(recordingId) {
  if (recordingId == null) return false;
  const key = String(recordingId);
  const now = Date.now();
  // prune expired entries
  for (const [k, ts] of RECENTLY_HANDLED) {
    if (now - ts > DEDUPE_TTL_MS) RECENTLY_HANDLED.delete(k);
  }
  if (RECENTLY_HANDLED.has(key)) return true;
  RECENTLY_HANDLED.set(key, now);
  return false;
}

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

  // Dedupe: if we've already handled this recording (e.g. Fathom retried the
  // webhook because our response was slow), acknowledge and skip re-posting.
  if (alreadyHandled(payload.recording_id)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  try {
    // The inline webhook transcript can be incomplete if Fathom is still
    // processing when it fires. Re-fetch the finalized meeting by recording id
    // so we score the FULL transcript. Wait briefly first to let Fathom finish,
    // then fall back to the inline payload if the fetch comes up empty.
    let meeting = payload;
    const recordingId = payload.recording_id;
    if (recordingId && process.env.FATHOM_API_KEY) {
      await new Promise((r) => setTimeout(r, 15000)); // 15s grace for processing
      const fetched = await fetchMeetingById(recordingId);
      if (fetched && Array.isArray(fetched.transcript) && fetched.transcript.length) {
        meeting = fetched;
      }
    }

    await processMeeting(meeting);
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
