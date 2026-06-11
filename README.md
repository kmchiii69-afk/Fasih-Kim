# Fathom → Discord Sales Call Bot

Auto-posts a structured summary of each closer's sales call to Discord.

**Flow:** Fathom finishes a call → webhook hits your Vercel function → Claude extracts the outcome data → a Discord embed is posted.

Each Discord post contains: outcome (closed / no close / follow-up / no-show), cash collected, deal value, qualified/not-qualified (+ reason), lead name, email, company, lead source, closer, payment plan, objections, next step, and a short recap.

---

## 1. Deploy to Vercel

```bash
npm i -g vercel        # if you don't have it
cd fathom-discord-bot
vercel                 # first deploy (follow prompts)
vercel --prod          # production deploy
```

Your endpoint will be: `https://<your-project>.vercel.app/api/fathom-webhook`

## 2. Set environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |
| `DISCORD_WEBHOOK_URL` | Discord channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL |
| `FATHOM_WEBHOOK_SECRET` | Returned when you create the Fathom webhook (step 3). Starts with `whsec_` |

Redeploy after adding them (`vercel --prod`).

## 3. Create the Fathom webhook

**Easiest — in Settings:** Fathom → User Settings → API Access → Manage → Add Webhook.
- Destination URL: your Vercel endpoint above
- Triggers: pick which recordings fire it (your own meetings and/or shared-with-you, so your closer's calls are covered)
- Include in payload: **Transcript**, **Summary**, and **CRM matches** (CRM matches helps pull lead email/company)
- Copy the signing secret it gives you → that's `FATHOM_WEBHOOK_SECRET`

**Or via API:**
```bash
curl -X POST https://api.fathom.ai/external/v1/webhooks \
  -H "X-Api-Key: YOUR_FATHOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "destination_url": "https://<your-project>.vercel.app/api/fathom-webhook",
    "include_transcript": true,
    "include_summary": true,
    "include_crm_matches": true,
    "include_action_items": false
  }'
```
The response contains the `secret` → use it for `FATHOM_WEBHOOK_SECRET`.

## 4. Test

Record a 2-minute test meeting in Fathom. Within a minute or two of ending it, the Discord channel should get a summary embed. If nothing arrives, check the Vercel function logs (Vercel → Deployments → your deploy → Functions/Logs).

---

## Notes & tuning

- **Closer name / lead source** come from the transcript. They land more reliably if your closer states them ("Hi, this is George…", "How'd you find us?"). Otherwise Claude falls back to Fathom's `recorded_by` for the closer.
- **Cash collected vs deal value:** the prompt is explicit — *cash collected* = money charged on the call, *deal value* = total program price. If your closer doesn't verbally confirm a charge, `cash_collected` stays null.
- **Local testing:** set `SKIP_VERIFY=true` to bypass signature checks while developing. Remove it before going live.
- **Long calls:** transcript is truncated to ~60k chars before sending to Claude; raise it in `extractWithClaude` if your calls run very long, but watch token cost.
- **Model:** currently `claude-sonnet-4-6`. Swap in the extraction call if you want a cheaper/faster one.
- **Serverless timeout:** extraction usually finishes well under Vercel's default. If you hit timeouts on long transcripts, bump `maxDuration` in `vercel.json` (Pro plans allow longer).

---

## Backfill — process existing/past calls on demand

The webhook only fires on *new* calls. To run summaries for calls that already happened (or to test against real data), use the **backfill** endpoint.

### Extra env vars it needs

| Variable | What it is |
|---|---|
| `FATHOM_API_KEY` | Your Fathom API key — User Settings → API Access. (This is the *read* key, different from the webhook signing secret.) |
| `BACKFILL_KEY` | A password you make up. You include it in the URL so randoms can't trigger backfills. E.g. `mysecret123`. |

Add both in Vercel → Settings → Environment Variables, then redeploy.

### How to run it

Just visit a URL in your browser (or paste it into a new tab):

```
https://<your-project>.vercel.app/api/backfill?key=YOUR_BACKFILL_KEY&limit=3
```

- `key` — must match your `BACKFILL_KEY`
- `limit` — how many recent calls to process (default 3, max 25)

**Recommended first run — dry run (lists calls, posts nothing):**
```
https://<your-project>.vercel.app/api/backfill?key=YOUR_BACKFILL_KEY&limit=3&dry=1
```
This shows you which calls it found (titles, who recorded them, whether a transcript exists) without touching Discord. Once it looks right, drop `&dry=1` to actually post them.

**Only one closer's calls:**
```
https://<your-project>.vercel.app/api/backfill?key=YOUR_BACKFILL_KEY&limit=5&recorded_by=closer@yourcompany.com
```

The page returns a small JSON report of what it processed; the actual summaries land in Discord.

> Tip for testing the whole setup: run the dry run first, then a real backfill with `limit=1`. If that one call shows up in Discord correctly, your entire pipeline works — and the live webhook (which shares the exact same code) will too.
