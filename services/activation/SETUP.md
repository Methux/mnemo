# Mnemo Pro — Activation Service Setup

## Architecture

```
LemonSqueezy (payment) → Webhook → Cloudflare Worker → KV (licenses)
                                         ↑
User (first run) → POST /activate ───────┘
                         ↓
                   Returns signed key (machine-bound)
```

## Step 1: LemonSqueezy Products

Create 3 products at https://app.lemonsqueezy.com:

| Product | Price | Variant |
|---------|-------|---------|
| Mnemo Pro Indie | $49/mo or $470/yr | Subscription |
| Mnemo Pro Team | $149/mo or $1,430/yr | Subscription |
| Mnemo Pro Enterprise | Contact sales | — |

Settings for each:
- Enable "Subscription" billing
- Add custom field: none needed (email captured automatically)

## Step 2: Cloudflare Worker

```bash
# Install wrangler
npm install -g wrangler

# Login
wrangler login

# Create KV namespace
wrangler kv namespace create LICENSES
wrangler kv namespace create LICENSES --preview

# Update wrangler.toml with the IDs from above

# Set secrets
wrangler secret put SIGNING_PRIVATE_KEY    # paste content of ~/.mnemo-private-key
wrangler secret put LEMONSQUEEZY_SECRET    # from LemonSqueezy webhook settings
wrangler secret put RESEND_API_KEY         # from resend.com

# Deploy
cd services/activation
wrangler deploy
```

Worker URL will be: `https://mnemo-activation.<your-account>.workers.dev`

Set up custom domain: `activation.mnemo.dev` → Worker route.

## Step 3: LemonSqueezy Webhook

In LemonSqueezy dashboard → Settings → Webhooks:
- URL: `https://activation.mnemo.dev/webhook/lemonsqueezy`
- Events: `order_created`, `subscription_expired`, `subscription_cancelled`
- Copy the signing secret → set as `LEMONSQUEEZY_SECRET` in Worker

## Step 4: Email (Resend)

1. Sign up at https://resend.com
2. Verify domain: `mnemo.dev`
3. Create API key → set as `RESEND_API_KEY` in Worker

## User Flow

### Automatic (recommended)
```
User pays → LemonSqueezy → Webhook → Worker generates token → Email sent
User runs: export MNEMO_LICENSE_TOKEN="mnemo_xxxxx"
First start: Mnemo auto-activates → key cached at ~/.mnemo/pro-key.json
Done. Pro features enabled.
```

### Manual (for offline / air-gapped)
```
You run: node ~/.mnemo-keygen.js --licensee "User" --email "user@co.com" --plan indie
Send key to user manually.
User runs: export MNEMO_PRO_KEY="eyJ...signature"
Done. No activation server needed.
```

## Machine Migration

User wants to move to a new machine:
```bash
# On old machine (or via API)
curl -X POST https://activation.mnemo.dev/deactivate \
  -H "Content-Type: application/json" \
  -d '{"token":"mnemo_xxxxx","machine_id":"<old-fingerprint>"}'

# On new machine
export MNEMO_LICENSE_TOKEN="mnemo_xxxxx"
# Mnemo auto-activates on next start
```

## Pricing Summary

| Plan | $/mo | $/yr | Keys | Support |
|------|------|------|------|---------|
| Core | Free | Free | — | GitHub Issues |
| Indie | $49 | $470 | 1 device | Email |
| Team | $149 | $1,430 | 5 devices | Priority + Slack |
| Enterprise | Custom | Custom | Unlimited | Dedicated |
