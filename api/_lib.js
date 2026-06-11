// api/_lib.js
// Shared logic used by both the webhook endpoint and the backfill endpoint:
//   - turning a Fathom meeting/transcript into plain text
//   - pulling context hints (closer, CRM, participants)
//   - Claude extraction of structured sales-call data
//   - building + posting the Discord embed

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

export async function extractWithClaude(transcriptText, hints) {
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
  const qualEmoji =
    d.qualified === "QUALIFIED"
      ? "🟢"
      : d.qualified === "NOT_QUALIFIED"
      ? "🔴"
      : "⚪";

  const fields = [
    { name: "Outcome", value: `${outcomeEmoji} ${d.outcome || "UNKNOWN"}`, inline: true },
    { name: "Cash Collected", value: fmtMoney(d.cash_collected, d.currency), inline: true },
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

// Process one Fathom meeting object end-to-end: extract + post to Discord.
export async function processMeeting(meeting) {
  const transcriptText = transcriptToText(meeting);
  const hints = contextHints(meeting);
  const extracted = await extractWithClaude(transcriptText, hints);
  const discordPayload = buildDiscordPayload(extracted, hints);
  await postToDiscord(discordPayload);
  return extracted;
}
