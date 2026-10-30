// Live smoke test for the configured HSP rail.
//   coordinator: reads /chains, pays 0.01 USDC nova.agent → pixel.design through mandate → transfer → observe → SETTLED
//   merchant:    opens a 0.01 USDC HashKey Merchant order for pixel.design and reads it back
import fs from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { SELLERS } from "./agents/catalog.js";
import { paymentNet, stable } from "./chain.js";
import { HSP_MODE, live, merchant } from "./config.js";
import { Coordinator } from "./hsp/coordinator.js";
import { MerchantClient } from "./hsp/merchant.js";
import { loadMerchantKeys } from "./hsp/merchant-crypto.js";
import { buildMandate, mandateHash, MANDATE_TYPES, type HspDomain } from "./hsp/wire.js";
import { MerchantRail } from "./rails.js";
import { store } from "./store.js";

const pixel = { ...SELLERS[0], priceUsd: "0.01" };

if (HSP_MODE === "merchant") {
  if (!merchant.appKey || !merchant.appSecret) throw new Error("Set HSP_APP_KEY and HSP_APP_SECRET in .env");
  if (!fs.existsSync(merchant.keyPath)) throw new Error(`Merchant private key not found at ${merchant.keyPath}`);
  const client = new MerchantClient({ baseUrl: merchant.baseUrl, appKey: merchant.appKey, appSecret: merchant.appSecret });
  const rail = new MerchantRail(client, loadMerchantKeys(merchant.keyPath), merchant.name, live.stablecoin as `0x${string}`, "check");
  console.log(`HashKey Merchant ${merchant.baseUrl} · ${paymentNet.config.label} · token ${live.stablecoin}`);
  const q = await rail.createQuote(pixel, store.agentKey("pixel.design"));
  console.log("Order created:", q.quoteId, q.payload.payment_url);
  console.log("Payment record:", await client.getPayment(q.quoteId));
  process.exit(0);
}

if (!live.coordinatorUrl) throw new Error("HSP_MODE is builtin: nothing hosted to check. Set HSP_COORDINATOR_URL (coordinator) or HSP_APP_KEY/SECRET (merchant)");
const hsp = new Coordinator(live.coordinatorUrl, live.apiKey);
const info = await hsp.chainInfo(paymentNet.config.chainId);
console.log("HSP chain:", info);
const key = store.agentKey("nova.agent");
const payer = privateKeyToAccount(key);
const to = privateKeyToAccount(store.agentKey("pixel.design")).address;
console.log(`payer ${payer.address}: ${await stable.gas(payer.address)} HSK, ${await stable.balance(info.stablecoin.address, payer.address)} USDC`);
if (!live.apiKey) throw new Error("Set HSP_API_KEY in .env");

const domain: HspDomain = { name: "HSP", version: "1", chainId: info.chainId, verifyingContract: info.verifyingContract };
const body = buildMandate({ signer: payer.address, to, token: info.stablecoin.address, amount: 10_000n, chainId: info.chainId });
const signerProof = await payer.signTypedData({ domain, types: MANDATE_TYPES, primaryType: "Mandate", message: { ...body, amount: BigInt(body.amount), chainId: BigInt(body.chainId), deadline: BigInt(body.deadline) } } as never);
const paymentId = await hsp.register(info.name, { body, signerProof, requiredCapabilities: [] });
console.log("registered", paymentId, paymentId === mandateHash(domain, body) ? "(matches local mandate hash)" : "(MISMATCH with local hash)");
const tx = await stable.transfer(key, info.stablecoin.address, to, 10_000n);
console.log("transfer", paymentNet.txUrl(tx));
await hsp.observe(info, paymentId, tx);
const final = await hsp.awaitTerminal(paymentId, (s) => console.log("status", s));
console.log(JSON.stringify(final, null, 2).slice(0, 2000));
console.log("explain:", hsp.paymentUrl(paymentId));
