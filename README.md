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
