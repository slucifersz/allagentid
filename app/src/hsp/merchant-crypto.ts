// HashKey Merchant (HSP gateway) signing primitives, from https://hashkey-merchant.github.io:
// canonical JSON, HMAC-SHA256 request signatures, ES256K merchant_authorization JWTs, webhooks.
import crypto from "node:crypto";
import fs from "node:fs";

export function sortKeys(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(val as object).sort()) out[k] = sortKeys((val as Record<string, unknown>)[k]);
  return out;
}

export const canonicalJSON = (obj: unknown) => JSON.stringify(sortKeys(obj));
export const sha256Hex = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
export const cartHash = (contents: unknown) => sha256Hex(canonicalJSON(contents));

// ---------------------------------------------------------------- HMAC request signing

export function hmacMessage(method: string, path: string, query: string, body: unknown | undefined, ts: string, nonce: string) {
  const bodyHash = body === undefined ? "" : sha256Hex(canonicalJSON(body));
  return `${method.toUpperCase()}\n${path}\n${query}\n${bodyHash}\n${ts}\n${nonce}`;
}

export function signRequest(appKey: string, appSecret: string, method: string, path: string, query: string, body?: unknown) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = crypto.createHmac("sha256", appSecret).update(hmacMessage(method, path, query, body, ts, nonce)).digest("hex");
  return { "X-App-Key": appKey, "X-Signature": sig, "X-Timestamp": ts, "X-Nonce": nonce };
}

export function verifyRequest(appSecret: string, headers: Record<string, string | undefined>, method: string, path: string, query: string, body?: unknown) {
  const ts = headers["x-timestamp"] ?? "";
  const nonce = headers["x-nonce"] ?? "";
  const sig = headers["x-signature"] ?? "";
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(hmacMessage(method, path, query, body, ts, nonce)).digest("hex");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------------------------------------------------------------- ES256K JWT

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signMerchantAuthorization(privateKeyPem: string, merchantName: string, contents: unknown) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256K", typ: "JWT" };
  const claims = { iss: merchantName, sub: merchantName, aud: "HashkeyMerchant", iat: now, exp: now + 3600, jti: `JWT-${now}-${crypto.randomBytes(6).toString("hex")}`, cart_hash: cartHash(contents) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/** Verify a merchant_authorization against the merchant's public key and the cart contents. */
export function verifyMerchantAuthorization(jwt: string, publicKeyPem: string, contents: unknown): { ok: true } | { ok: false; error: string } {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return { ok: false, error: "malformed JWT" };
  if (JSON.parse(Buffer.from(h, "base64url").toString()).alg !== "ES256K") return { ok: false, error: "alg must be ES256K" };
  const valid = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKeyPem, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!valid) return { ok: false, error: "bad merchant signature" };
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (claims.aud !== "HashkeyMerchant") return { ok: false, error: "wrong audience" };
  if (claims.exp < Date.now() / 1000) return { ok: false, error: "merchant authorization expired" };
  if (claims.cart_hash !== cartHash(contents)) return { ok: false, error: "cart contents do not match cart_hash" };
  return { ok: true };
}

/** The merchant key pair registered with HSP (PEM private key on disk; public key derived from it). */
export function loadMerchantKeys(privateKeyPath: string) {
  const priv = crypto.createPrivateKey(fs.readFileSync(privateKeyPath, "utf8"));
  return {
    privateKeyPem: priv.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: crypto.createPublicKey(priv).export({ type: "spki", format: "pem" }).toString(),
  };
}

// ---------------------------------------------------------------- webhooks

export function signWebhook(appSecret: string, rawBody: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", appSecret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export function verifyWebhook(appSecret: string, header: string | undefined, rawBody: string) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(`${parts.t}.${rawBody}`).digest("hex");
  return typeof parts.v1 === "string" && parts.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}
