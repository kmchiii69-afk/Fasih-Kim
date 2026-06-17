// api/_lib.js
// Shared logic used by both the webhook endpoint and the backfill endpoint.

import { readFileSync } from "fs";
import { join } from "path";

// Load the ICP scoring rubric once (from icp-criteria.md at the repo root).
// Editing that file changes scoring with no code changes.
let ICP_CRITERIA = "";
try {
  ICP_CRITERIA = readFileSync(join(process.cwd(), "icp-criteria.md"), "utf8");
} catch {
  ICP_CRITERIA =
    "No ICP criteria file found. Score all factors as null and total 0.";
}


// ---------- meeting filter ----------

// Meetings whose title contains any of these phrases are skipped entirely
// (internal calls, huddles, group sessions). Case-insensitive substring match.
// Edit this list to change what gets filtered out.
const EXCLUDED_TITLE_PHRASES = [
  "internal huddle",
  "sales huddle",
  "team call",
  "team meeting",
  "group call",
  "mastermind",
  "gc executives call",
  "fulfilment call",
  "q&a",
];

// Meetings where any of these emails appear (as a participant or the recorder)
// are skipped, regardless of the title.
const EXCLUDED_EMAILS = ["lazzartopalovic@gmail.com"];

// Returns true if this meeting should be SKIPPED (not posted to Discord).
export function shouldSkipMeeting(payload) {
  const title =
    payload.meeting_title || payload.title || payload.recording?.title || "";
  const lower = title.toLowerCase();
  if (EXCLUDED_TITLE_PHRASES.some((phrase) => lower.includes(phrase))) {
    return true;
  }

  // Collect every email associated with the meeting.
  const emails = [];
  const people =
    payload.calendar_invitees || payload.invitees || payload.participants || [];
  if (Array.isArray(people)) {
    for (const p of people) if (p?.email) emails.push(p.email.toLowerCase());
  }
  const rec = payload.recorded_by;
  if (rec) {
    const recEmail = typeof rec === "string" ? rec : rec.email;
    if (recEmail) emails.push(recEmail.toLowerCase());
  }

  const blocked = EXCLUDED_EMAILS.map((e) => e.toLowerCase());
  return emails.some((e) => blocked.includes(e));
}


// ---------- transcript -> text ----------

export function transcriptToText(payload) {
  const t = payload.transcript;
  if (Array.isArray(t)) {
    return t
      .map((row) => {
        const name = row.speaker?.display_name || "Unknown";
        return `${name}: ${row.text}`;
      })
      .join("\n");
  }
  // Fall back to the summary markdown if transcript wasn't included.
  const sum = payload.default_summary?.markdown_formatted || payload.summary;
  if (typeof sum === "string") return sum;
  return JSON.stringify(payload).slice(0, 12000);
}

// ---------- context hints ----------

export function contextHints(payload) {
  const hints = {};

  hints.meeting_title =
    payload.meeting_title || payload.title || payload.recording?.title || null;

  // recorded_by is an object on /meetings, sometimes a string on webhooks.
  if (payload.recorded_by) {
    hints.recorded_by =
      typeof payload.recorded_by === "string"
        ? payload.recorded_by
        : payload.recorded_by.name || payload.recorded_by.email || null;
  }

  // CRM matches: contacts / companies / deals
  const crm = payload.crm_matches;
  if (crm && !crm.error) {
    if (Array.isArray(crm.contacts) && crm.contacts.length)
      hints.crm_contacts = crm.contacts.map((c) => ({
        name: c.name,
        email: c.email,
      }));
    if (Array.isArray(crm.companies) && crm.companies.length)
      hints.crm_companies = crm.companies.map((c) => c.name);
    if (Array.isArray(crm.deals) && crm.deals.length)
      hints.crm_deals = crm.deals.map((d) => ({
        name: d.name,
        amount: d.amount,
      }));
  }

  // External invitees are the likely "lead" side of the call.
  const invitees = payload.calendar_invitees || payload.invitees;
  if (Array.isArray(invitees) && invitees.length) {
    hints.participants = invitees.map((p) => ({
      name: p.name,
      email: p.email,
      external: p.is_external,
    }));
  }

  // Shareable Fathom recording link, preferring the public share URL.
  hints.share_url =
    payload.share_url || payload.url || payload.recording?.url || null;

  return hints;
}

// ---------- Claude extraction ----------

const EXTRACTION_SCHEMA = `{
  "lead_name": "string | null",
  "lead_source": "string | null (where the lead came from, e.g. YouTube, Instagram, referral, paid ad, webinar)",
  "outcome": "one of: CLOSED | NO_CLOSE | FOLLOW_UP | NO_SHOW | UNKNOWN",
  "cash_collected": "number | null (amount actually collected on the call, in the currency stated; null if none)",
  "currency": "string | null (e.g. USD, MYR)",
  "deal_value": "number | null (total contract / program price discussed)",
  "icp_score": {
    "budget": "number | null (0-30, per criteria; null if not discussed)",
    "income": "number | null (0-25; null if not discussed)",
    "pain": "number | null (0-20; null if not discussed)",
    "opportunity_cost": "number | null (0-15; null if not discussed)",
    "social_proof": "number | null (0-10; null if not discussed)",
    "total": "number (sum of the factor scores that were scored; out of 100)",
    "missing_factors": ["array of factor names that were not discussed, e.g. income"],
    "reason": "string (one short line explaining the overall score)"
  },
  "objections": ["array of short strings"],
  "next_step": "string | null",
  "summary": "string (2-3 sentence neutral recap of what happened on the call)"
}`;

export async function extractWithClaude(transcriptText, hints) {
  const system =
    "You are a precise sales-call analyst. You read a sales call transcript and " +
    "extract structured outcome data for a Discord report, AND score the lead " +
    "against the provided ICP scoring criteria. Only use facts present in the " +
    "transcript or the provided context hints. If something is not stated, use " +
    'null (or "UNKNOWN" for the outcome enum) rather than guessing. Cash collected ' +
    "means money actually charged/collected on this call, NOT the total deal value. " +
    "For scoring: follow the ICP criteria exactly, score each factor within its " +
    "point range, and if a factor was never discussed set it to null and list it " +
    "in missing_factors (do not guess, do not count it as zero). The total is the " +
    "sum of the factors you DID score. " +
    "OUTCOME — read the ENTIRE transcript for close signals, not just the ending. " +
    "Many calls close mid-conversation and the recording keeps going. Mark CLOSED " +
    "if ANY of these happen anywhere in the call: the prospect agrees to buy or " +
    "join; payment is taken or card/billing details are collected; a payment plan " +
    "is agreed; the closer says things like 'welcome aboard', 'let's get you " +
    "started', 'I'll send the onboarding', or confirms next steps that only happen " +
    "after a sale; the prospect says yes/I'm in/let's do it. Do NOT default to " +
    "NO_CLOSE just because the transcript lacks a tidy closing line or cuts off. " +
    "Use NO_CLOSE only when the prospect clearly declines or no agreement is " +
    "reached. Use FOLLOW_UP when they want time to decide or a second call is set. " +
    "Use NO_SHOW only if the prospect never joined. If genuinely ambiguous, prefer " +
    "FOLLOW_UP over NO_CLOSE. " +
    "Respond with ONLY a single valid JSON object, no markdown, no preamble.";

  // The outcome (close/payment) usually happens at the END of a call, so if a
  // transcript is too long to send whole, keep the LAST chunk, not the first.
  // Limit is generous; Claude's context handles large transcripts fine.
  const MAX_TRANSCRIPT_CHARS = 200000;
  let tx = transcriptText;
  if (tx.length > MAX_TRANSCRIPT_CHARS) {
    tx =
      "[earlier transcript truncated]\n" +
      tx.slice(tx.length - MAX_TRANSCRIPT_CHARS);
  }

  const userContent =
    `ICP SCORING CRITERIA:\n"""\n${ICP_CRITERIA}\n"""\n\n` +
    `Context hints (may be incomplete):\n${JSON.stringify(hints, null, 2)}\n\n` +
    `Return JSON matching exactly this schema:\n${EXTRACTION_SCHEMA}\n\n` +
    `Transcript:\n"""\n${tx}\n"""`;

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

// ---------- Discord ----------

function fmtMoney(amount, currency) {
  if (amount == null) return "—";
  const cur = currency || "";
  return `${cur} ${Number(amount).toLocaleString()}`.trim();
}

export function buildDiscordPayload(d, hints) {
  const closed = d.outcome === "CLOSED";
  const noShow = d.outcome === "NO_SHOW";

  const color = closed
    ? 0x57f287
    : noShow
    ? 0x4f545c
    : d.outcome === "FOLLOW_UP"
    ? 0xe9bc53
    : 0xed4245;

  const outcomeEmoji = closed
    ? "✅"
    : noShow
    ? "👻"
    : d.outcome === "FOLLOW_UP"
    ? "🔁"
    : "❌";

  // Build the per-factor ICP score breakdown.
  const s = d.icp_score || {};
  const factorLine = (label, val, max) =>
    `${label}: ${val == null ? "—" : val}/${max}`;
  const breakdown = [
    factorLine("Budget", s.budget, 30),
    factorLine("Income", s.income, 25),
    factorLine("Pain", s.pain, 20),
    factorLine("Opp. cost", s.opportunity_cost, 15),
    factorLine("Social proof", s.social_proof, 10),
  ].join("\n");

  const total = s.total != null ? s.total : "—";
  const scoreEmoji =
    typeof s.total === "number"
      ? s.total >= 85
        ? "🟢"
        : s.total >= 65
        ? "🟡"
        : s.total >= 45
        ? "🟠"
        : "🔴"
      : "⚪";

  const fields = [
    { name: "Outcome", value: `${outcomeEmoji} ${d.outcome || "UNKNOWN"}`, inline: true },
    { name: "Cash Collected", value: fmtMoney(d.cash_collected, d.currency), inline: true },
    { name: "Deal Value", value: fmtMoney(d.deal_value, d.currency), inline: true },
    { name: "Lead", value: d.lead_name || "—", inline: true },
    { name: "Lead Source", value: d.lead_source || "—", inline: true },
    {
      name: `Lead Score ${scoreEmoji} ${total}/100`,
      value:
        breakdown +
        (Array.isArray(s.missing_factors) && s.missing_factors.length
          ? `\n_Not discussed: ${s.missing_factors.join(", ")} (total is provisional)_`
          : ""),
      inline: false,
    },
  ];

  if (Array.isArray(d.objections) && d.objections.length) {
    fields.push({
      name: "Objections",
      value: d.objections.map((o) => `• ${o}`).join("\n").slice(0, 1024),
      inline: false,
    });
  }

  const watchLine = hints.share_url
    ? `\n\n🎥 [Watch the call](${hints.share_url})`
    : "";

  const embed = {
    title: `${outcomeEmoji} Sales Call — ${d.lead_name || "Unknown Lead"}`,
    description: (d.summary || "").slice(0, 3900) + watchLine,
    color,
    fields,
    footer: { text: hints.meeting_title || "Fathom call summary" },
    timestamp: new Date().toISOString(),
  };

  // Makes the embed title itself a clickable link to the recording.
  if (hints.share_url) embed.url = hints.share_url;

  return { embeds: [embed] };
}

export async function postToDiscord(payload) {
  const resp = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`Discord ${resp.status}: ${await resp.text()}`);
  }
}

// Fetch the finalized meeting (full transcript + summary + CRM) from Fathom's
// /meetings API by recording id. Used by the webhook because the inline webhook
// transcript can be incomplete if Fathom is still processing when it fires.
// Returns the meeting object, or null if it can't be found/fetched.
export async function fetchMeetingById(recordingId) {
  if (!recordingId || !process.env.FATHOM_API_KEY) return null;

  const params = new URLSearchParams();
  params.set("include_transcript", "true");
  params.set("include_summary", "true");
  params.set("include_crm_matches", "true");

  // Page through recent meetings to find the matching recording id.
  let cursor = null;
  for (let i = 0; i < 5; i++) {
    if (cursor) params.set("cursor", cursor);
    const resp = await fetch(
      `https://api.fathom.ai/external/v1/meetings?${params.toString()}`,
      { headers: { "X-Api-Key": process.env.FATHOM_API_KEY } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const items = data.items || [];
    const match = items.find(
      (m) => String(m.recording_id) === String(recordingId)
    );
    if (match) return match;
    cursor = data.next_cursor;
    if (!cursor || items.length === 0) break;
  }
  return null;
}

// Process one Fathom meeting object end-to-end: extract + post to Discord.
// Returns { skipped: true } if the meeting was filtered out by title.
export async function processMeeting(meeting) {
  if (shouldSkipMeeting(meeting)) {
    return { skipped: true };
  }
  const transcriptText = transcriptToText(meeting);
  const hints = contextHints(meeting);
  const extracted = await extractWithClaude(transcriptText, hints);
  const discordPayload = buildDiscordPayload(extracted, hints);
  await postToDiscord(discordPayload);
  return extracted;
}
