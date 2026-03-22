/**
 * Mnemo Pro — Activation & Webhook Worker (Cloudflare Workers)
 *
 * Endpoints:
 *   POST /webhook/lemonsqueezy  — LemonSqueezy payment webhook
 *   POST /activate              — Device activation (bind token → machine)
 *   GET  /license/:token        — Check activation status
 *   POST /deactivate            — Release device binding (for machine migration)
 *
 * Environment bindings (wrangler.toml):
 *   KV:  LICENSES — token → { payload, machine_id, activated_at, key }
 *   Secrets:
 *     SIGNING_PRIVATE_KEY  — Ed25519 private key (base64)
 *     LEMONSQUEEZY_SECRET  — webhook signing secret
 *     RESEND_API_KEY       — email delivery
 */

// ── Crypto helpers ──

async function signLicense(payload, privateKeyB64) {
  const privKeyDer = base64ToArrayBuffer(privateKeyB64);
  const key = await crypto.subtle.importKey(
    "pkcs8", privKeyDer, { name: "Ed25519" }, false, ["sign"]
  );
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("Ed25519", key, payloadBytes);
  const payloadB64 = arrayBufferToBase64(payloadBytes.buffer);
  const sigB64 = arrayBufferToBase64(signature);
  return `${payloadB64}.${sigB64}`;
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── LemonSqueezy webhook signature verification ──

async function verifyWebhookSignature(body, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = arrayBufferToBase64(signed);
  // LemonSqueezy sends hex signature
  const expectedHex = Array.from(new Uint8Array(signed))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return signature === expectedHex;
}

// ── Email delivery via Resend ──

async function sendLicenseEmail(email, licensee, token, plan, resendApiKey) {
  const activationUrl = `https://mnemo.dev/activate?token=${token}`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Mnemo Pro <license@mnemo.dev>",
      to: [email],
      subject: `Your Mnemo Pro License (${plan})`,
      html: `
        <div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#4ecdc4;">Mnemo Pro — License Activated</h2>
          <p>Hi ${licensee},</p>
          <p>Thank you for purchasing Mnemo Pro (${plan} plan).</p>
          <p>Your license token:</p>
          <pre style="background:#0a0a1a;color:#4ecdc4;padding:16px;border-radius:8px;font-size:14px;word-break:break-all;">${token}</pre>
          <h3>Quick Start</h3>
          <p>Run this in your terminal to activate:</p>
          <pre style="background:#0a0a1a;color:#e0e0e0;padding:16px;border-radius:8px;font-size:13px;">export MNEMO_LICENSE_TOKEN="${token}"
npm run activate
# or
node -e "require('@mnemo/core').activate()"</pre>
          <p>This will bind the license to your machine and generate your <code>MNEMO_PRO_KEY</code>.</p>
          <h3>Manual Activation</h3>
          <p>Or visit: <a href="${activationUrl}" style="color:#4ecdc4;">${activationUrl}</a></p>
          <hr style="border:1px solid #2a2a4a;margin:20px 0;">
          <p style="color:#666;font-size:12px;">
            Plan: ${plan} | Token: ${token.slice(0, 12)}...<br>
            Questions? Reply to this email or visit <a href="https://mnemo.dev/pro" style="color:#4ecdc4;">mnemo.dev/pro</a>
          </p>
        </div>
      `,
    }),
  });
}

// ── Generate unique token ──

function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "mnemo_" + arrayBufferToBase64(bytes.buffer)
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Machine fingerprint validation ──

function isValidFingerprint(fp) {
  // SHA-256 hex = 64 chars
  return typeof fp === "string" && /^[a-f0-9]{64}$/.test(fp);
}

// ── Request handlers ──

async function handleWebhook(request, env) {
  const body = await request.text();
  const signature = request.headers.get("x-signature") || "";

  // Verify LemonSqueezy webhook signature
  const valid = await verifyWebhookSignature(body, signature, env.LEMONSQUEEZY_SECRET);
  if (!valid) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  const event = JSON.parse(body);
  const eventName = event.meta?.event_name;

  if (eventName === "order_created") {
    const attrs = event.data?.attributes || {};
    const email = attrs.user_email;
    const licensee = attrs.user_name || email;
    const productName = attrs.first_order_item?.product_name || "";

    // Determine plan from product name
    let plan = "indie";
    if (productName.toLowerCase().includes("team")) plan = "team";
    else if (productName.toLowerCase().includes("enterprise")) plan = "enterprise";

    // Determine how many keys to generate
    const keyCount = plan === "indie" ? 1 : plan === "team" ? 5 : 20;

    const tokens = [];
    for (let i = 0; i < keyCount; i++) {
      const token = generateToken();
      // Store token in KV (unactivated)
      await env.LICENSES.put(token, JSON.stringify({
        licensee,
        email,
        plan,
        issued: new Date().toISOString().slice(0, 10),
        expires: "", // subscription managed by LemonSqueezy
        machine_id: null,
        activated_at: null,
        key: null,
        order_id: event.data?.id || "",
      }));
      tokens.push(token);
    }

    // Send email with token(s)
    await sendLicenseEmail(email, licensee, tokens[0], plan, env.RESEND_API_KEY);

    return new Response(JSON.stringify({ ok: true, tokens_created: keyCount }), { status: 200 });
  }

  if (eventName === "subscription_expired" || eventName === "subscription_cancelled") {
    // TODO: mark associated tokens as expired in KV
    return new Response(JSON.stringify({ ok: true, action: "noted" }), { status: 200 });
  }

  return new Response(JSON.stringify({ ok: true, action: "ignored" }), { status: 200 });
}

async function handleActivate(request, env) {
  const { token, machine_id } = await request.json();

  if (!token || !machine_id) {
    return new Response(
      JSON.stringify({ error: "Missing token or machine_id" }),
      { status: 400 }
    );
  }

  if (!isValidFingerprint(machine_id)) {
    return new Response(
      JSON.stringify({ error: "Invalid machine_id format (expected SHA-256 hex)" }),
      { status: 400 }
    );
  }

  // Look up token
  const raw = await env.LICENSES.get(token);
  if (!raw) {
    return new Response(
      JSON.stringify({ error: "Invalid token" }),
      { status: 404 }
    );
  }

  const license = JSON.parse(raw);

  // Already activated on a different machine?
  if (license.machine_id && license.machine_id !== machine_id) {
    return new Response(
      JSON.stringify({
        error: "Token already activated on another device",
        hint: "Use /deactivate first, or contact support for migration",
        activated_on: license.activated_at,
      }),
      { status: 409 }
    );
  }

  // Already activated on this machine — return existing key
  if (license.machine_id === machine_id && license.key) {
    return new Response(
      JSON.stringify({ key: license.key, status: "already_activated" }),
      { status: 200 }
    );
  }

  // Activate: sign a machine-bound key
  const payload = {
    licensee: license.licensee,
    email: license.email,
    plan: license.plan,
    issued: license.issued,
    expires: license.expires,
    machine_id,
  };

  const key = await signLicense(payload, env.SIGNING_PRIVATE_KEY);

  // Update KV
  license.machine_id = machine_id;
  license.activated_at = new Date().toISOString();
  license.key = key;
  await env.LICENSES.put(token, JSON.stringify(license));

  return new Response(
    JSON.stringify({ key, status: "activated" }),
    { status: 200 }
  );
}

async function handleDeactivate(request, env) {
  const { token, machine_id } = await request.json();

  if (!token) {
    return new Response(JSON.stringify({ error: "Missing token" }), { status: 400 });
  }

  const raw = await env.LICENSES.get(token);
  if (!raw) {
    return new Response(JSON.stringify({ error: "Invalid token" }), { status: 404 });
  }

  const license = JSON.parse(raw);

  // Verify caller owns this activation
  if (license.machine_id !== machine_id) {
    return new Response(
      JSON.stringify({ error: "Machine ID mismatch" }),
      { status: 403 }
    );
  }

  // Clear activation
  license.machine_id = null;
  license.activated_at = null;
  license.key = null;
  await env.LICENSES.put(token, JSON.stringify(license));

  return new Response(
    JSON.stringify({ status: "deactivated", hint: "You can now activate on a new device" }),
    { status: 200 }
  );
}

async function handleLicenseCheck(token, env) {
  const raw = await env.LICENSES.get(token);
  if (!raw) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

  const license = JSON.parse(raw);
  return new Response(JSON.stringify({
    licensee: license.licensee,
    plan: license.plan,
    activated: !!license.machine_id,
    activated_at: license.activated_at,
  }), { status: 200 });
}

// ── Router ──

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...headers,
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      if (request.method === "POST" && url.pathname === "/webhook/lemonsqueezy") {
        return await handleWebhook(request, env);
      }
      if (request.method === "POST" && url.pathname === "/activate") {
        const resp = await handleActivate(request, env);
        return new Response(resp.body, { status: resp.status, headers });
      }
      if (request.method === "POST" && url.pathname === "/deactivate") {
        const resp = await handleDeactivate(request, env);
        return new Response(resp.body, { status: resp.status, headers });
      }
      if (request.method === "GET" && url.pathname.startsWith("/license/")) {
        const token = url.pathname.split("/license/")[1];
        const resp = await handleLicenseCheck(token, env);
        return new Response(resp.body, { status: resp.status, headers });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Internal error", detail: err.message }),
        { status: 500, headers }
      );
    }
  },
};
