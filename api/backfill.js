// api/backfill.js
// On-demand: pull recent Fathom calls and post a summary for each to Discord.
// Use this to catch up on past calls, or to test against real data.
//
// Call it from your browser:
//   https://<your-project>.vercel.app/api/backfill?key=YOUR_BACKFILL_KEY&limit=3
//
// Query params:
//   key    (required) must match BACKFILL_KEY env var — stops randoms triggering it
//   limit  (optional) how many recent calls to process (default 3, max 25)
//   recorded_by (optional) email of the closer, to only pull their calls
//   dry    (optional) "1" = list what WOULD be processed, don't post to Discord
//
// Env vars (in addition to the webhook ones):
//   FATHOM_API_KEY   your Fathom API key (User Settings -> API Access)
//   BACKFILL_KEY     any password you make up; you pass it in the URL

import { processMeeting, shouldSkipMeeting, isAmbiguousTitle } from "./_lib.js";

const FATHOM_BASE = "https://api.fathom.ai/external/v1";

async function listMeetings({ limit, recordedBy }) {
  const params = new URLSearchParams();
  params.set("include_transcript", "true");
  params.set("include_summary", "true");
  params.set("include_crm_matches", "true");
  if (recordedBy) params.append("recorded_by[]", recordedBy);

  const collected = [];
  let cursor = null;

  // Page until we have `limit` meetings (or run out).
  while (collected.length < limit) {
    if (cursor) params.set("cursor", cursor);
    const resp = await fetch(`${FATHOM_BASE}/meetings?${params.toString()}`, {
      headers: { "X-Api-Key": process.env.FATHOM_API_KEY },
    });
    if (!resp.ok) {
      throw new Error(`Fathom list ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    const items = data.items || [];
    collected.push(...items);
    cursor = data.next_cursor;
    if (!cursor || items.length === 0) break;
  }

  return collected.slice(0, limit);
}

export default async function handler(req, res) {
  // Simple shared-secret gate.
  const key = req.query.key;
  if (!key || key !== process.env.BACKFILL_KEY) {
    return res.status(401).json({ error: "Unauthorized (bad or missing key)" });
  }

  const limit = Math.min(parseInt(req.query.limit || "3", 10) || 3, 25);
  const recordedBy = req.query.recorded_by || null;
  const dry = req.query.dry === "1";

  try {
    const meetings = await listMeetings({ limit, recordedBy });

    if (meetings.length === 0) {
      return res.status(200).json({ ok: true, message: "No meetings found." });
    }

    // Dry run: just report what we'd process, don't call Claude/Discord.
    if (dry) {
      return res.status(200).json({
        ok: true,
        dry_run: true,
        count: meetings.length,
        meetings: meetings.map((m) => ({
          recording_id: m.recording_id,
          title: m.meeting_title || m.title,
          recorded_by: m.recorded_by?.name,
          started: m.recording_start_time,
          has_transcript: Array.isArray(m.transcript) && m.transcript.length > 0,
          will_skip: shouldSkipMeeting(m)
            ? "FILTERED OUT (internal/group)"
            : isAmbiguousTitle(m)
            ? "WILL CLASSIFY (ambiguous title — sales vs internal)"
            : false,
        })),
      });
    }

    // Process sequentially to stay friendly with rate limits.
    const results = [];
    for (const m of meetings) {
      try {
        const extracted = await processMeeting(m);
        if (extracted.skipped) {
          results.push({
            recording_id: m.recording_id,
            skipped: true,
            reason: extracted.reason || "filtered",
            title: m.meeting_title || m.title,
          });
          continue;
        }
        results.push({
          recording_id: m.recording_id,
          ok: true,
          outcome: extracted.outcome,
          lead: extracted.lead_name,
        });
      } catch (err) {
        results.push({
          recording_id: m.recording_id,
          ok: false,
          error: String(err).slice(0, 300),
        });
      }
    }

    return res.status(200).json({
      ok: true,
      processed: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => r.skipped).length,
      results,
    });
  } catch (err) {
    console.error("Backfill error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
