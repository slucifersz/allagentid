// Local stand-in for the HashKey Merchant (HSP) gateway, built to the public merchant docs so
// the same client runs against it and the real gateway. It checks HMAC request signatures,
// the ES256K merchant_authorization and cart_hash, settles x402 / EIP-3009 Payment Mandates
// on-chain and walks the payment status machine. Its checkout page has a "pay as owner"
// button standing in for the owner's wallet.
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import type { Address, Hex } from "viem";
import { paymentNet, relayTransferWithAuthorization, toUnits } from "../chain.js";
import { verifyMerchantAuthorization, verifyRequest } from "./merchant-crypto.js";
import type { CartMandate, MerchantPayment, MerchantStatus, PaymentMandate } from "./merchant.js";

interface Flow {
  flow_id: string;
  cart: CartMandate;
  payTotal: string;
  payments: MerchantPayment[];
}

const ok = (res: Response, data: unknown) => res.json({ code: 0, msg: "success", data });
const fail = (res: Response, http: number, code: number, msg: string) => res.status(http).json({ code, msg });
const now = () => new Date().toISOString();

export function createMerchantEmulator(o: {
  appKey: string;
  appSecret: string;
  merchantPublicKeyPem: string;
  relayerKey: Hex;
  publicUrl: string;
  /** Signs a Payment Mandate as the owner's wallet (local demo of the hosted checkout). */
  ownerPay: (cart: CartMandate, total: string) => Promise<PaymentMandate>;
}) {
  const router = express.Router();
  const flows = new Map<string, Flow>();
  const byRequest = new Map<string, Flow>();
  const nonces = new Set<string>();

  function authed(req: Request, res: Response, body?: unknown) {
    const h = req.headers as Record<string, string>;
    const [pathOnly, query = ""] = req.originalUrl.split("?");
    const key = `${h["x-app-key"]}:${h["x-nonce"]}`;
    if (h["x-app-key"] !== o.appKey || nonces.has(key) || !verifyRequest(o.appSecret, h, req.method, pathOnly, query, body)) {
      fail(res, 401, 10002, "unauthorized: bad HMAC signature");
      return false;
    }
    nonces.add(key);
    return true;
  }

  router.post("/api/v1/merchant/orders", (req, res) => {
    if (!authed(req, res, req.body)) return;
    const cart = req.body?.cart_mandate as CartMandate | undefined;
    if (!cart?.contents) return fail(res, 400, 10001, "cart_mandate is required");
    const v = verifyMerchantAuthorization(cart.merchant_authorization, o.merchantPublicKeyPem, cart.contents);
    if (!v.ok) return fail(res, 401, 10002, v.error);
    const d = cart.contents.payment_request.details;
    if (byRequest.has(d.id)) return fail(res, 400, 40001, "cart mandate already used");
    if (d.display_items?.length && Math.abs(d.display_items.reduce((s, i) => s + Number(i.amount.value), 0) - Number(d.total.amount.value)) > 1e-9)
      return fail(res, 400, 10001, "display_items do not add up to total");
    const flow: Flow = { flow_id: crypto.randomUUID(), cart, payTotal: d.modifiers?.find((m) => m.total)?.total?.amount.value ?? d.total.amount.value, payments: [] };
    flows.set(flow.flow_id, flow);
    byRequest.set(d.id, flow);
    ok(res, { payment_request_id: d.id, payment_url: `${o.publicUrl}/flow/${flow.flow_id}`, multi_pay: false });
  });

  router.get("/api/v1/merchant/payments", (req, res) => {
    if (!authed(req, res)) return;
    const flow = byRequest.get(String(req.query.payment_request_id));
    if (!flow) return fail(res, 404, 10003, "payment not found");
    ok(res, flow.payments.at(-1) ?? { payment_request_id: flow.cart.contents.payment_request.details.id, flow_id: flow.flow_id, status: "payment-required" });
  });

  async function accept(flow: Flow, pm: PaymentMandate) {
    if (flow.payments.some((p) => p.status !== "payment-failed")) throw new Error("cart mandate already consumed");
    const pmc = pm.payment_mandate_contents;
    const x = pmc.payment_response.details;
    const m = flow.cart.contents.payment_request.method_data.find((md) => md.data.pay_to.toLowerCase() === x.payload.authorization.to.toLowerCase() && `eip155:${md.data.chain_id}` === x.network);
    if (!m) throw new Error("payment does not match any method in the cart mandate");
    if (pmc.payment_mandate_id !== flow.cart.contents.payment_request.details.id) throw new Error("payment_mandate_id must equal payment_request_id");
    if (BigInt(x.payload.authorization.value) !== toUnits(flow.payTotal)) throw new Error(`amount must be ${flow.payTotal}`);
    const rec: MerchantPayment = {
      payment_request_id: pmc.payment_mandate_id,
      request_id: pmc.payment_response.request_id,
      flow_id: flow.flow_id,
      status: "payment-submitted",
      payer_address: x.payload.authorization.from,
      to_pay_address: m.data.pay_to,
      pay_amount: flow.payTotal,
      token: m.data.coin,
      token_address: m.data.contract_address,
      created_at: now(),
    };
    flow.payments.push(rec);
    const set = (status: MerchantStatus, extra: Partial<MerchantPayment> = {}) => Object.assign(rec, { status, updated_at: now(), ...extra });
    (async () => {
      set("payment-verified");
      try {
        set("payment-processing");
        const hash = await relayTransferWithAuthorization(o.relayerKey, m.data.contract_address as Address, x.payload.authorization, x.payload.signature);
        const r = await paymentNet.client.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error("transfer reverted");
        set("payment-included", { tx_signature: hash });
        setTimeout(() => set("payment-safe"), 1500);
        setTimeout(() => set("payment-finalized"), 3000);
      } catch (e) {
        set("payment-failed", { status_reason: (e as Error).message.split("\n")[0] });
      }
    })();
    return rec;
  }

  // Payer side: what the hosted checkout submits after the wallet signs.
  router.post("/api/v1/payment/pay-mandate", async (req, res) => {
    const flow = flows.get(req.body?.flow_id);
    if (!flow) return fail(res, 404, 10003, "flow not found");
    try {
      const rec = await accept(flow, req.body.payment_mandate);
      ok(res, { flow_id: flow.flow_id, request_id: rec.request_id, status: rec.status });
    } catch (e) {
      fail(res, 400, 10001, (e as Error).message);
    }
  });

  // Hosted checkout (local): shows the order; "Pay as owner" stands in for the owner's wallet.
  router.get("/flow/:id", (req, res) => {
    const flow = flows.get(req.params.id);
    if (!flow) return res.status(404).send("Not found");
    const c = flow.cart.contents;
    const m = c.payment_request.method_data[0].data;
    const last = flow.payments.at(-1);
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HSP Checkout</title>
<body style="font-family:system-ui;max-width:460px;margin:40px auto;padding:0 16px">
<p style="color:#888">HSP checkout · HashKey Merchant (local) · ${paymentNet.config.label}</p>
<h2>${c.merchant_name}</h2>
${(c.payment_request.details.display_items ?? []).map((i) => `<p>${i.label} — $${i.amount.value}</p>`).join("")}
<h3>Total ${flow.payTotal} ${m.coin}</h3>
<p>Pay to <code>${m.pay_to}</code></p>
<p>Status: <b id="st">${last?.status ?? "payment-required"}</b>${last?.tx_signature ? `<br>Tx <code>${last.tx_signature}</code>` : ""}</p>
${last ? "" : `<form method="post" action="${o.publicUrl}/flow/${flow.flow_id}/owner-pay"><button style="font:inherit;padding:10px 18px;border-radius:9px;background:#5b5bf7;color:#fff;border:0">Pay with owner wallet (EIP-3009)</button></form>`}
</body>`);
  });

  router.post("/flow/:id/owner-pay", async (req, res) => {
    const flow = flows.get(req.params.id);
    if (!flow) return res.status(404).send("Not found");
    try {
      await accept(flow, await o.ownerPay(flow.cart, flow.payTotal));
    } catch (e) {
      return res.status(400).send((e as Error).message);
    }
    res.redirect(303, `${o.publicUrl}/flow/${flow.flow_id}`);
  });

  return router;
}
