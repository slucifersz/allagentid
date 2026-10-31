// HTTP surface: dashboard API + SSE, seller agents (A2A), HSP emulators (local), MCP.
import path from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BUYER, CLIENT, SELLERS, sellerByHandle } from "./agents/catalog.js";
import { PayAgent } from "./agents/payer.js";
import { agentUrl, createSellerRouter } from "./agents/seller.js";
import { ANVIL_ADAPTER, bootChain, seedAgents } from "./bootstrap.js";
import crypto from "node:crypto";
import { paymentNet, registryNet, signTransferAuthorization, stable, toUnits } from "./chain.js";
import { HSP_MODE, MODE, PORT, PUBLIC_URL, ROOT, agentic, live, merchant } from "./config.js";
import { emit, onEvent, recentEvents } from "./events.js";
import { Coordinator, type HspChainInfo } from "./hsp/coordinator.js";
import { createCoordinatorEmulator } from "./hsp/emulator.js";
import { MerchantClient } from "./hsp/merchant.js";
import { loadMerchantKeys } from "./hsp/merchant-crypto.js";
import { createMerchantEmulator } from "./hsp/merchant-emulator.js";
import { AgenticRail, CoordinatorRail, MerchantRail, type Rail } from "./rails.js";
import { HspAgentic } from "./hsp/agentic.js";
import { createAgenticEmulator } from "./hsp/agentic-emulator.js";
import { Cards } from "./cards.js";
import { buildMcpServer } from "./mcp.js";
import { store } from "./store.js";

const { registry, localToken } = await bootChain();

/** Pick the HSP token on PAYMENT_NETWORK from get_chain_config. */
async function agenticRail(hsp: HspAgentic, deferred: boolean): Promise<Rail> {
  if (deferred) {
    // local emulator: its config is known without a round trip
    const cfg = { network: paymentNet.config.hspName, chainId: paymentNet.config.chainId, symbol: "USDC", address: localToken!, decimals: 6, protocol: "eip3009" };
    return new AgenticRail(hsp, cfg, agentic.merchantName, `HSP Agentic Payment (local) · ${agentic.merchantName}`, agentic.pollMs);
  }
  const { tokens } = await hsp.chainConfig();
  const pick = tokens.filter((t) => t.chainId === paymentNet.config.chainId && t.symbol.toUpperCase() === agentic.token.toUpperCase());
  const cfg = pick.find((t) => t.protocol === "eip3009") ?? pick[0];
  if (!cfg) {
    const offered = tokens.map((t) => `${t.network}(${t.chainId}) ${t.symbol} ${t.protocol}`).join(", ");
    throw new Error(`HSP get_chain_config has no ${agentic.token} on ${paymentNet.config.label} (chain ${paymentNet.config.chainId}). Offered: ${offered}. Set PAYMENT_NETWORK / HSP_TOKEN to one of these.`);
  }
  return new AgenticRail(hsp, cfg, agentic.merchantName, `HSP Agentic Payment (QA) · ${agentic.merchantName}`, agentic.pollMs);
}
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

// HSP rail (HSP_MODE): Settlement Protocol via a hosted or built-in Coordinator, or the
// HashKey Merchant gateway. In local mode the HSP side is always an in-process emulator.
let rail: Rail;
if (HSP_MODE === "agentic") {
  let url = agentic.url;
  if (MODE === "local") {
    app.use("/hsp-agentic", createAgenticEmulator({ token: localToken!, relayerKey: ANVIL_ADAPTER, publicUrl: `${PUBLIC_URL}/hsp-agentic` }));
    url = `http://localhost:${PORT}/hsp-agentic/`;
  }
  const hsp = new HspAgentic(url);
  // the server isn't listening yet in local mode, so the emulator is read once it is (see below)
  rail = await agenticRail(hsp, MODE === "local");
} else if (HSP_MODE === "merchant") {
  const keys = loadMerchantKeys(merchant.keyPath);
  let client: MerchantClient;
  let token: Hex;
  if (MODE === "local") {
    const emu = { appKey: "ak_local", appSecret: "local-secret" };
    const ownerKey = store.ownerKey();
    app.use(
      "/hsp-merchant",
      createMerchantEmulator({
        ...emu,
        merchantPublicKeyPem: keys.publicKeyPem,
        relayerKey: ANVIL_ADAPTER,
        publicUrl: `${PUBLIC_URL}/hsp-merchant`,
        ownerPay: async (cart, total) => {
          const m = cart.contents.payment_request.method_data[0].data;
          const { authorization, signature } = await signTransferAuthorization(ownerKey, m.contract_address as Hex, m.pay_to as Hex, toUnits(total));
          const id = cart.contents.payment_request.details.id;
          return {
            payment_mandate_contents: {
              payment_mandate_id: id,
              payment_details_id: id,
              payment_details_total: { label: "Total", amount: { currency: "USD", value: total } },
              payment_response: { request_id: `REQ-${crypto.randomUUID()}`, method_name: "https://www.x402.org/", details: { x402Version: 2, scheme: "exact", network: `eip155:${m.chain_id}`, payload: { signature, authorization } } },
              merchant_agent: cart.contents.merchant_name,
              timestamp: new Date().toISOString(),
            },
            user_authorization: signature,
          };
        },
      }),
    );
    client = new MerchantClient({ baseUrl: `http://localhost:${PORT}/hsp-merchant`, ...emu, payMandateUrl: merchant.payMandateUrl ? `http://localhost:${PORT}/hsp-merchant/api/v1/payment/pay-mandate` : undefined });
    token = localToken!;
  } else {
    client = new MerchantClient({ baseUrl: merchant.baseUrl, appKey: merchant.appKey, appSecret: merchant.appSecret, payMandateUrl: merchant.payMandateUrl || undefined });
    token = live.stablecoin as Hex;
  }
  rail = new MerchantRail(client, keys, merchant.name, token, client.canPayByApi ? "HashKey Merchant · agent pays by API" : "HashKey Merchant · owner pays at checkout");
} else {
  const hosted = MODE === "live" && HSP_MODE === "coordinator";
  let coordinator: Coordinator;
  let chainInfo: HspChainInfo;
  if (hosted) {
    coordinator = new Coordinator(live.coordinatorUrl, live.apiKey);
    chainInfo = await coordinator.chainInfo(paymentNet.config.chainId);
  } else {
    const token = (MODE === "live" ? live.stablecoin : localToken) as Hex;
    if (!token) throw new Error("No stablecoin for the built-in HSP Coordinator; set STABLECOIN_ADDRESS");
    const adapterKey = MODE === "live" ? store.agentKey("_hsp-adapter") : ANVIL_ADAPTER;
    const emu = createCoordinatorEmulator({ apiKey: "built-in", token, adapterKey, publicUrl: `${PUBLIC_URL}/hsp` });
    app.use("/hsp", emu.router);
    coordinator = new Coordinator(`http://localhost:${PORT}/hsp`, "built-in");
    chainInfo = emu.chainInfo;
  }
  const proofUrl = (id: string) => (hosted ? coordinator.paymentUrl(id as Hex) : `${PUBLIC_URL}/hsp/payments/${id}/explain`);
  rail = new CoordinatorRail(coordinator, chainInfo, hosted ? "HSP Coordinator (hosted)" : "HSP Coordinator (built-in)", proofUrl);
}
const token = rail.token;

const walletOf = (handle: string) => privateKeyToAccount(store.agentKey(handle)).address;
const buyers = new Set<string>([BUYER.handle, CLIENT.handle]);
const cards = new Cards(registry);
const payAgent = new PayAgent({
  registry,
  rail,
  agentKey: (h) => store.agentKey(h),
  sellerA2aUrl: (h) => `http://localhost:${PORT}/agents/${h}/a2a`,
});

app.use("/agents", createSellerRouter({ rail, agentKey: (h) => store.agentKey(h) }));

// ---------------------------------------------------------------- dashboard API

async function passportCard(handle: string) {
  const wallet = walletOf(handle);
  const [p, balance, gas] = await Promise.all([registry.passport(wallet), stable.balance(token, wallet), stable.gas(wallet)]);
  const s = sellerByHandle(handle);
  return {
    handle,
    role: handle === BUYER.handle ? "you" : handle === CLIENT.handle ? "client" : s ? "seller" : "agent",
    name: handle === BUYER.handle ? BUYER.name : handle === CLIENT.handle ? CLIENT.name : (s?.name ?? handle),
    wallet,
    walletUrl: paymentNet.addressUrl(wallet),
    balance,
    gas,
    passport: p,
    ...(s ? { skill: s.skill.name, tags: s.skill.tags, price: s.priceUsd, perCall: !!s.payPerCall, blurb: s.blurb, agentCard: `${agentUrl(handle)}/.well-known/agent-card.json` } : {}),
  };
}

const publicJob = (j: Parameters<typeof payAgent.publicJob>[0]) => payAgent.publicJob(j);

app.get("/api/state", async (_req, res) => {
  const handles = [...buyers, ...SELLERS.map((s) => s.handle)];
  res.json({
    mode: MODE,
    registryNet: { label: registryNet.config.label, chainId: registryNet.config.chainId, explorer: registryNet.config.explorer },
    paymentNet: { label: paymentNet.config.label, chainId: paymentNet.config.chainId, explorer: paymentNet.config.explorer },
    registry: registry.address,
    registryUrl: registryNet.addressUrl(registry.address),
    token,
    testStablecoin: live.testStablecoin,
    hspMode: HSP_MODE,
    hsp: rail.label,
    passports: await Promise.all(handles.map(passportCard)),
    account: await account(BUYER.handle),
    jobs: [...payAgent.jobs.values()].reverse().map(publicJob),
  });
});

/** The agent's whole AllScale account: identity, balance, rules, cards. */
async function account(handle: string) {
  const wallet = walletOf(handle);
  const [p, balance] = await Promise.all([registry.passport(wallet), stable.balance(token, wallet)]);
  return {
    handle,
    identity: p && { tier: p.tier, tierName: p.tierName, owner: p.owner, wallet, registry: registry.address, network: registryNet.config.label },
    balances: { stablecoin: { asset: "USDC", amount: balance, network: paymentNet.config.label }, allscaleAccount: { status: "demo", note: "AllScale account (USD virtual account), coming soon for agents" } },
    rules: p && { ...p.policy, spentToday: p.spentToday, cardSpentToday: cards.cardSpentToday(handle).toFixed(2) },
    payments: { rail: rail.label, paid: p?.settlementsPaid, received: p?.settlementsReceived, volumePaid: p?.volumePaid, volumeReceived: p?.volumeReceived },
    cards: cards.list(handle),
  };
}

app.get("/api/accounts/:handle", async (req, res) => res.json(await account(req.params.handle)));

app.post("/api/accounts/:handle/cards", async (req, res) => {
  const { merchant, amountUsd } = req.body ?? {};
  if (!merchant || !amountUsd) return res.status(400).json({ error: "merchant and amountUsd are required" });
  try {
    res.json(await cards.issueOneTime(req.params.handle, walletOf(req.params.handle), String(merchant), String(amountUsd)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Receive: a client agent pays Nova through HSP for Nova's service. */
app.post("/api/receive", async (req, res) => {
  const { from = CLIENT.handle, task = "Market brief: stablecoin checkout in India" } = req.body ?? {};
  res.json(publicJob(await payAgent.hire(from, BUYER.handle, task)));
});

app.get("/api/passports/:handle", async (req, res) => {
  const wallet = (await registry.resolve(req.params.handle)) as Hex;
  if (/^0x0+$/.test(wallet)) return res.status(404).json({ error: "no passport with that handle" });
  const p = await registry.passport(wallet);
  res.json({ ...p, balance: await stable.balance(token, wallet), walletUrl: paymentNet.addressUrl(wallet) });
});

app.post("/api/passports", async (req, res) => {
  const { handle } = req.body ?? {};
  try {
    const wallet = walletOf(handle);
    const tx = await registry.issuePassport(privateKeyToAccount(store.ownerKey()).address, handle, wallet);
    buyers.add(handle);
    emit({ kind: "passport", title: `Passport issued: @${handle}`, txHash: tx });
    res.json({ handle, wallet, tx, txUrl: registryNet.txUrl(tx) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message.split("\n")[0] });
  }
});

app.post("/api/passports/:handle/policy", async (req, res) => {
  const { perTxUsd, dailyUsd, minTier } = req.body ?? {};
  try {
    const tx = await registry.setPolicy(walletOf(req.params.handle), String(perTxUsd), String(dailyUsd), Number(minTier));
    emit({ kind: "passport", title: `@${req.params.handle} policy: ≤${perTxUsd}/payment, ≤${dailyUsd}/day, payee tier ≥ ${minTier}`, txHash: tx });
    res.json({ tx, txUrl: registryNet.txUrl(tx) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message.split("\n")[0] });
  }
});

app.post("/api/hire", async (req, res) => {
  const { payer = BUYER.handle, seller, task } = req.body ?? {};
  if (!sellerByHandle(seller)) return res.status(400).json({ error: `unknown seller ${seller}` });
  if (!task) return res.status(400).json({ error: "task is required" });
  res.json(publicJob(await payAgent.hire(payer, seller, task)));
});

app.post("/api/jobs/:id/approve", async (req, res) => {
  try {
    res.json(publicJob(await payAgent.approve(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/jobs/:id/decline", (req, res) => {
  try {
    res.json(publicJob(payAgent.decline(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** The scripted demo: one AllScale onboarding gives Nova identity, an account, payments and a card. */
let demoRunning = false;
app.post("/api/demo", (_req, res) => {
  if (demoRunning) return res.status(409).json({ error: "demo already running" });
  demoRunning = true;
  res.json({ started: true });
  (async () => {
    const a = await account(BUYER.handle);
    emit({ kind: "passport", title: `@${BUYER.handle} has a passport: ${a.identity?.tierName}`, detail: `identity on ${registryNet.config.label} · ${a.balances.stablecoin.amount} USDC · ≤${a.rules?.perTxLimit}/payment, ≤${a.rules?.dailyLimit}/day` });
    emit({ kind: "info", title: `Nova reads its own account`, detail: `identity ${a.identity?.tierName} · balance ${a.balances.stablecoin.amount} USDC · card •••• ${a.cards[0].last4} (demo)` });
    await payAgent.hire(CLIENT.handle, BUYER.handle, "Market brief: stablecoin checkout in India"); // receive
    await payAgent.hire(BUYER.handle, "pixel.design", "Diwali sale: 50% off when you pay with stablecoins"); // pay
    await payAgent.hire(BUYER.handle, "ghost.design", "Diwali sale poster"); // refused: unverified
    await payAgent.hire(BUYER.handle, "studio.video", "Diwali launch video"); // over limit → owner
    await cards.issueOneTime(BUYER.handle, walletOf(BUYER.handle), "Online store order", "4.50"); // card (demo)
    emit({ kind: "info", title: "One AllScale onboarding: identity, an account, payments and a card." });
  })()
    .catch((e) => emit({ kind: "reject", title: "Demo error", detail: (e as Error).message }))
    .finally(() => (demoRunning = false));
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  for (const e of recentEvents()) res.write(`data: ${JSON.stringify(e)}\n\n`);
  const off = onEvent((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    off();
    clearInterval(ping);
  });
});

// ---------------------------------------------------------------- MCP over streamable HTTP

app.post("/mcp", async (req, res) => {
  const server = buildMcpServer(`http://localhost:${PORT}`);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "use POST" }));

await seedAgents(registry, token);

app.listen(PORT, () => {
  console.log(`\nAllScale Agent ID · ${MODE === "live" ? `passports on ${registryNet.config.label}, HSP on ${paymentNet.config.label}` : "local chain + HSP emulator"}`);
  console.log(`  Dashboard  ${PUBLIC_URL}`);
  console.log(`  MCP        ${PUBLIC_URL}/mcp`);
  console.log(`  Agents     ${PUBLIC_URL}/agents`);
  console.log(`  HSP        ${rail.label} (HSP_MODE=${HSP_MODE})`);
  console.log(`  Registry   ${registry.address}\n`);
});
