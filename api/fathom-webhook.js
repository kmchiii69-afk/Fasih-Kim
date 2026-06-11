// api/fathom-webhook.js
// Fathom "new meeting content ready" webhook -> Claude extraction -> Discord
//
// Flow:
//   1. Fathom POSTs meeting payload here (transcript + summary + crm_matches)
//   2. Verify the webhook signature (Svix-style HMAC)
//   3. Send transcript to Claude -> structured sales-call data (JSON)
//   4. Format a Discord embed and POST to your Discord webhook URL
//
// Env vars required (set in Vercel project settings):
//   FATHOM_WEBHOOK_SECRET   whsec_...   (given when you create the webhook)
//   ANTHROPIC_API_KEY       sk-ant-...
//   DISCORD_WEBHOOK_URL      https://discord.com/api/webhooks/....

import crypto from "crypto";

// We need the RAW body for signature verification, so disable Vercel's parser.
export const config = { api: { bodyParser: false } };

// ---------- helpers ----------

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

  // Reject stale messages (replay protection, 5 min tolerance)
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

// Turn Fathom's transcript array into plain "Speaker: text" lines.
function transcriptToText(payload) {
  const t = payload.transcript;
  if (Array.isArray(t)) {
    return t
      .map((row) => {
        const name = row.speaker?.display_name || "Unknown";
        return `${name}: ${row.text}`;
      })
      .join("\n");
  }
  // Fall back to summary if transcript wasn't included in the webhook.
  if (typeof payload.summary === "string") return payload.summary;
  return JSON.stringify(payload).slice(0, 12000);
}

// Pull whatever participant/CRM hints Fathom gives us, to help Claude.
function contextHints(payload) {
  const hints = {};
  if (payload.recording?.title || payload.title)
    hints.meeting_title = payload.recording?.title || payload.title;
  if (payload.recorded_by) hints.recorded_by = payload.recorded_by;

  const matches = payload.crm_matches || payload.crm_match || [];
  if (Array.isArray(matches) && matches.length) hints.crm_matches = matches;

  // Best-effort: collect any invitee emails/names Fathom surfaces.
  const people =
    payload.invitees || payload.participants || payload.attendees || [];
  if (Array.isArray(people) && people.length) hints.participants = people;

  return hints;
}

// ---------- Claude extraction ----------

const EXTRACTION_SCHEMA = `{
  "lead_name": "string | null",
  "lead_email": "string | null",
  "lead_company": "string | null",
  "lead_source": "string | null (where the lead came from, e.g. YouTube, Instagram, referral, paid ad, webinar)",
  "closer_name": "string | null",
  "outcome": "one of: CLOSED | NO_CLOSE | FOLLOW_UP | NO_SHOW | UNKNOWN",
  "qualified": "one of: QUALIFIED | NOT_QUALIFIED | UNKNOWN",
  "disqualification_reason": "string | null (only if NOT_QUALIFIED)",
  "cash_collected": "number | null (amount actually collected on the call, in the currency stated; null if none)",
  "currency": "string | null (e.g. USD, MYR)",
  "deal_value": "number | null (total contract / program price discussed)",
  "payment_plan": "string | null (e.g. paid in full, 3-month split)",
  "objections": ["array of short strings"],
  "next_step": "string | null",
  "summary": "string (2-3 sentence neutral recap of what happened on the call)"
}`;

async function extractWithClaude(transcriptText, hints) {
  const system =
    "You are a precise sales-call analyst. You read a sales call transcript and " +
    "extract structured outcome data for a Discord report. Only use facts present " +
    "in the transcript or the provided context hints. If something is not stated, " +
    'use null (or "UNKNOWN" for the enum fields) rather than guessing. Cash collected ' +
    "means money actually charged/collected on this call, NOT the total deal value. " +
    "Respond with ONLY a single valid JSON object, no markdown, no preamble.";

  const userContent =
    `Context hints (may be incomplete):\n${JSON.stringify(hints, null, 2)}\n\n` +
    `Return JSON matching exactly this schema:\n${EXTRACTION_SCHEMA}\n\n` +
    `Transcript:\n"""\n${transcriptText.slice(0, 60000)}\n"""`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const clean = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(clean);
}

// ---------- Discord formatting ----------

function fmtMoney(amount, currency) {
  if (amount == null) return "—";
  const cur = currency || "";
  return `${cur} ${Number(amount).toLocaleString()}`.trim();
}

function buildDiscordPayload(d, hints) {
  const closed = d.outcome === "CLOSED";
  const noShow = d.outcome === "NO_SHOW";

  // green closed, red no-close, grey no-show/unknown, gold follow-up
  const color = closed
    ? 0x57f287
    : noShow
    ? 0x4f545c
    : d.outcome === "FOLLOW_UP"
    ? 0xe9bc53
    : 0xed4245;

  const outcomeEmoji = closed ? "✅" : noShow ? "👻" : d.outcome === "FOLLOW_UP" ? "🔁" : "❌";
  const qualEmoji =
    d.qualified === "QUALIFIED" ? "🟢" : d.qualified === "NOT_QUALIFIED" ? "🔴" : "⚪";

  const fields = [
    { name: "Outcome", value: `${outcomeEmoji} ${d.outcome || "UNKNOWN"}`, inline: true },
    {
      name: "Cash Collected",
      value: fmtMoney(d.cash_collected, d.currency),
      inline: true,
    },
    { name: "Deal Value", value: fmtMoney(d.deal_value, d.currency), inline: true },
    {
      name: "Qualified",
      value: `${qualEmoji} ${d.qualified || "UNKNOWN"}${
        d.qualified === "NOT_QUALIFIED" && d.disqualification_reason
          ? ` — ${d.disqualification_reason}`
          : ""
      }`,
      inline: false,
    },
    { name: "Lead", value: d.lead_name || "—", inline: true },
    { name: "Email", value: d.lead_email || "—", inline: true },
    { name: "Company", value: d.lead_company || "—", inline: true },
    { name: "Lead Source", value: d.lead_source || "—", inline: true },
    { name: "Closer", value: d.closer_name || hints.recorded_by || "—", inline: true },
    { name: "Payment Plan", value: d.payment_plan || "—", inline: true },
  ];

  if (Array.isArray(d.objections) && d.objections.length) {
    fields.push({
      name: "Objections",
      value: d.objections.map((o) => `• ${o}`).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (d.next_step) {
    fields.push({ name: "Next Step", value: d.next_step.slice(0, 1024), inline: false });
  }

  return {
    embeds: [
      {
        title: `${outcomeEmoji} Sales Call — ${d.lead_name || "Unknown Lead"}`,
        description: (d.summary || "").slice(0, 4000),
        color,
        fields,
        footer: { text: hints.meeting_title || "Fathom call summary" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function postToDiscord(payload) {
  const resp = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`Discord ${resp.status}: ${await resp.text()}`);
  }
}

// ---------- handler ----------

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

  // Verify signature (skip only if you explicitly set SKIP_VERIFY for local tests)
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

  // ACK Fathom immediately so the webhook doesn't time out / retry,
  // then do the heavy work. On serverless, finish before returning instead:
  try {
    const transcriptText = transcriptToText(payload);
    const hints = contextHints(payload);

    const extracted = await extractWithClaude(transcriptText, hints);
    const discordPayload = buildDiscordPayload(extracted, hints);
    await postToDiscord(discordPayload);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Processing error:", err);
    // Surface a minimal Discord alert so a failure is still visible.
    try {
      await postToDiscord({
        content: `⚠️ Fathom call summary failed to process: ${String(err).slice(0, 300)}`,
      });
    } catch {}
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
