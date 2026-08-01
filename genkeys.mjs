/**
 * Generates the VAPID keypair used to sign push notifications.
 * Run once:   node genkeys.mjs
 * Then store the two values as Worker secrets (see PUSH-SETUP.md).
 */
import { webcrypto as c } from "node:crypto";

const kp = await c.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

const jwk = await c.subtle.exportKey("jwk", kp.privateKey);
const pub = new Uint8Array(await c.subtle.exportKey("raw", kp.publicKey));
const b64u = b => Buffer.from(b).toString("base64url");

console.log("\n  VAPID_PUBLIC_KEY   =", b64u(pub));
console.log("  VAPID_PRIVATE_KEY  =", jwk.d);
console.log("\n  Keep the private key secret. Store both with:");
console.log("    npx wrangler secret put VAPID_PUBLIC_KEY");
console.log("    npx wrangler secret put VAPID_PRIVATE_KEY");
console.log("    npx wrangler secret put VAPID_SUBJECT     (e.g. mailto:you@example.com)\n");
