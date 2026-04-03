/**
 * Mnemo LemonSqueezy Webhook — Cloudflare Worker
 *
 * Handles:
 *   - subscription_created → send npm token to customer
 *   - subscription_cancelled / expired → notify owner
 *   - license_key_created → log
 *
 * Secrets (set via `wrangler secret put`):
 *   - LEMON_SIGNING_SECRET: LemonSqueezy webhook signing secret
 *   - NPM_READ_TOKEN: read-only npm token for @mnemoai/pro
 *   - NOTIFY_EMAIL: owner email for alerts (optional)
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    // Verify signature
    const signature = request.headers.get("x-signature");
    const body = await request.text();

    if (!signature || !env.LEMON_SIGNING_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const valid = await verifySignature(body, signature, env.LEMON_SIGNING_SECRET);
    if (!valid) {
      return new Response("Invalid signature", { status: 403 });
    }

    // Parse event
    const payload = JSON.parse(body);
    const eventName = payload.meta?.event_name;
    const customData = payload.meta?.custom_data || {};
    const attrs = payload.data?.attributes || {};
    const customerEmail = attrs.user_email || attrs.customer_email || "";
    const customerName = attrs.user_name || attrs.customer_name || "";
    const productName = attrs.product_name || attrs.first_order_item?.product_name || "";

    console.log(`[webhook] ${eventName} — ${customerEmail} — ${productName}`);

    switch (eventName) {
      case "subscription_created":
      case "order_created":
        // Send npm token to customer
        if (customerEmail && env.NPM_READ_TOKEN) {
          await sendNpmToken(customerEmail, customerName, productName, env);
        }
        break;

      case "subscription_cancelled":
      case "subscription_expired":
        // Notify owner
        console.log(`[webhook] Subscription ended: ${customerEmail} (${productName})`);
        break;

      case "license_key_created":
        console.log(`[webhook] License created for ${customerEmail}`);
        break;

      default:
        console.log(`[webhook] Unhandled event: ${eventName}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};

// ── HMAC-SHA256 signature verification ──

async function verifySignature(body, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expected === signature;
}

// ── Send npm token email via MailChannels (free on CF Workers) ──

async function sendNpmToken(email, name, product, env) {
  const token = env.NPM_READ_TOKEN;
  const greeting = name ? `Hi ${name.split(" ")[0]}` : "Hi";

  const htmlBody = `
${greeting},<br><br>
Thanks for subscribing to <strong>${product || "Mnemo Pro"}</strong>!<br><br>
<strong>Step 1:</strong> Add this to your <code>~/.npmrc</code>:<br>
<pre>//registry.npmjs.org/:_authToken=${token}</pre>
<strong>Step 2:</strong> Set your license key:<br>
<pre>export MNEMO_PRO_KEY="your-license-key-from-email"</pre>
<strong>Step 3:</strong> Install:<br>
<pre>npm install @mnemoai/pro</pre>
<br>
Pro features activate automatically — no code changes needed.<br><br>
Documentation: <a href="https://docs.m-nemo.ai">docs.m-nemo.ai</a><br><br>
If you have any questions, reply to this email.<br><br>
— Mnemo Team
`;

  const textBody = `${greeting},

Thanks for subscribing to ${product || "Mnemo Pro"}!

Step 1: Add this to your ~/.npmrc:
//registry.npmjs.org/:_authToken=${token}

Step 2: Set your license key:
export MNEMO_PRO_KEY="your-license-key-from-email"

Step 3: Install:
npm install @mnemoai/pro

Pro features activate automatically — no code changes needed.

Documentation: https://docs.m-nemo.ai

— Mnemo Team`;

  try {
    const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email, name: name || email }] }],
        from: { email: "pro@m-nemo.ai", name: "Mnemo Pro" },
        subject: `Your Mnemo Pro npm access token`,
        content: [
          { type: "text/plain", value: textBody },
          { type: "text/html", value: htmlBody },
        ],
      }),
    });

    if (!resp.ok) {
      console.error(`[email] Failed: ${resp.status} ${await resp.text()}`);
    } else {
      console.log(`[email] npm token sent to ${email}`);
    }
  } catch (err) {
    console.error(`[email] Error: ${err}`);
  }
}
