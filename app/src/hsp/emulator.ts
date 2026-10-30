// Local stand-in for the HSP Coordinator, following the hackathon developer guide:
// it registers signed mandates, observes the payer's own ERC-20 transfer on-chain, runs
// the verifier (required ⊆ satisfied capabilities) and signs a receipt with an adapter key.
// It never moves funds, same as the real one.
import express, { type Request, type Response } from "express";
import { decodeEventLog, keccak256, parseAbi, recoverAddress, stringToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentNet } from "../chain.js";
import type { HspChainInfo } from "./coordinator.js";
import { decodeAddress, mandateHash, requiredCapabilitiesHash, type HspDomain, type SignedMandate } from "./wire.js";

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const SETTLEMENT_VERIFIED = keccak256(stringToBytes("proves:settlement-verified:v1"));

interface Record_ {
  paymentId: Hex;
  chain: string;
  status: "REGISTERED" | "OBSERVING" | "SETTLED" | "FAILED";
  mandate: SignedMandate;
  attestations: unknown[];
  registeredAt: string;
  txHash?: Hex;
  receipt?: { adapterId: string; paymentId: Hex; txHash: Hex; blockNumber: string; from: Address; to: Address; amount: string; satisfiedCapabilities: Hex[]; observedAt: string; adapterSignature: Hex };
  decision?: { ok: boolean; outcomeClass: "ACCEPT" | "RETRYABLE" | "POLICY" | "PERMANENT"; reason: string };
  trace: { at: string; step: string }[];
}

export function createCoordinatorEmulator(o: { apiKey: string; token: Address; adapterKey: Hex; publicUrl: string }) {
  const router = express.Router();
  const adapter = privateKeyToAccount(o.adapterKey);
  const chainInfo: HspChainInfo = {
    name: paymentNet.config.hspName,
    chainId: paymentNet.config.chainId,
    stablecoin: { address: o.token, symbol: "USDC", decimals: 6 },
    confirmations: 1,
    verifyingContract: "0x0000000000000000000000000000000000000001",
    adapterAddress: adapter.address,
    adapterOperatorUrl: null,
  };
  const domain: HspDomain = { name: "HSP", version: "1", chainId: chainInfo.chainId, verifyingContract: chainInfo.verifyingContract };
  const payments = new Map<string, Record_>();
  const stats = { registered: 0, settled: 0, failed: 0 };

  const authed = (req: Request, res: Response) => {
    if (req.header("authorization") !== `Bearer ${o.apiKey}`) {
      res.status(401).json({ error: "missing or invalid API key" });
      return false;
    }
    return true;
  };
  const log = (p: Record_, step: string) => p.trace.push({ at: new Date().toISOString(), step });

  router.get("/chains", (_req, res) => res.json([chainInfo]));
  router.get("/stats", (_req, res) => res.json(stats));

  router.post("/payments", async (req, res) => {
    if (!authed(req, res)) return;
    const { chain, mandate, attestations = [] } = req.body as { chain: string; mandate: SignedMandate; attestations?: unknown[] };
    const b = mandate?.body;
    if (!b) return res.status(400).json({ error: "mandate required" });
    if (chain !== chainInfo.name || Number(b.chainId) !== chainInfo.chainId) return res.status(400).json({ error: "unsupported chain" });
    if (b.token.toLowerCase() !== o.token.toLowerCase()) return res.status(400).json({ error: "token is not the pinned stablecoin" });
    if (b.deadline < Date.now() / 1000) return res.status(400).json({ error: "mandate expired" });
    if (requiredCapabilitiesHash(mandate.requiredCapabilities) !== b.requiredCapabilitiesHash) return res.status(400).json({ error: "requiredCapabilitiesHash mismatch" });
    const paymentId = mandateHash(domain, b);
    const signer = await recoverAddress({ hash: paymentId, signature: mandate.signerProof }).catch(() => null);
    if (!signer || signer.toLowerCase() !== decodeAddress(b.signer.payload).toLowerCase()) return res.status(400).json({ error: "signerProof does not match mandate signer" });
    if (payments.has(paymentId)) return res.status(409).json({ error: "mandate already registered", paymentId });
    const p: Record_ = { paymentId, chain, status: "REGISTERED", mandate, attestations, registeredAt: new Date().toISOString(), trace: [] };
    log(p, `mandate registered; EIP-712 signature recovers ${signer}`);
    payments.set(paymentId, p);
    stats.registered++;
    res.status(201).json({ paymentId, status: p.status });
  });

  router.post("/payments/:id/observe", async (req, res) => {
    if (!authed(req, res)) return;
    const p = payments.get(req.params.id);
    if (!p) return res.status(404).json({ error: "unknown payment" });
    if (p.status === "SETTLED" || p.status === "FAILED") return res.json({ status: p.status });
    const txHash = req.body?.txHash as Hex;
    const rcpt = await paymentNet.client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!rcpt) return res.status(202).json({ status: "OBSERVING" });
    p.status = "OBSERVING";
    p.txHash = txHash;
    log(p, `observing ${txHash} in block ${rcpt.blockNumber}`);

    const b = p.mandate.body;
    const want = { from: decodeAddress(b.signer.payload).toLowerCase(), to: decodeAddress(b.recipient.payload).toLowerCase(), amount: BigInt(b.amount) };
    const hit = rcpt.logs
      .filter((l) => l.address.toLowerCase() === o.token.toLowerCase())
      .map((l) => {
        try {
          return decodeEventLog({ abi: TRANSFER, data: l.data, topics: l.topics }).args;
        } catch {
          return null;
        }
      })
      .find((a) => a && a.from.toLowerCase() === want.from && a.to.toLowerCase() === want.to && a.value === want.amount);

    if (rcpt.status !== "success" || !hit) {
      p.status = "FAILED";
      p.decision = { ok: false, outcomeClass: "PERMANENT", reason: "no Transfer from the mandate signer to the recipient for the mandated amount" };
      stats.failed++;
      log(p, p.decision.reason);
      return res.json({ status: p.status });
    }
    const satisfied = [SETTLEMENT_VERIFIED];
    const body = { adapterId: "evm-transfer", paymentId: p.paymentId, txHash, blockNumber: rcpt.blockNumber.toString(), from: hit.from, to: hit.to, amount: hit.value.toString(), satisfiedCapabilities: satisfied, observedAt: new Date().toISOString() };
    p.receipt = { ...body, adapterSignature: await adapter.signMessage({ message: JSON.stringify(body) }) };
    log(p, `receipt signed by adapter ${adapter.address}`);
    const required = p.mandate.requiredCapabilities.map((c) => c.toLowerCase());
    const ok = required.every((c) => satisfied.includes(c as Hex));
    p.decision = ok ? { ok, outcomeClass: "ACCEPT", reason: "requiredCapabilities ⊆ satisfiedCapabilities" } : { ok, outcomeClass: "POLICY", reason: "required capabilities not satisfied" };
    p.status = ok ? "SETTLED" : "FAILED";
    stats[ok ? "settled" : "failed"]++;
    log(p, `verifier: ${p.decision.outcomeClass}`);
    res.json({ status: p.status });
  });

  router.get("/payments/:id", (req, res) => {
    const p = payments.get(req.params.id);
    if (!p) return res.status(404).json({ error: "unknown payment" });
    res.json(p);
  });

  router.get("/payments/:id/explain", (req, res) => {
    const p = payments.get(req.params.id);
    if (!p) return res.status(404).send("Unknown payment");
    const b = p.mandate.body;
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HSP payment</title>
<body style="font-family:system-ui;max-width:680px;margin:32px auto;padding:0 16px">
<p style="color:#888">HSP Coordinator (built-in) · ${paymentNet.config.label}</p>
<h2>Payment ${p.status}</h2>
<p><b>${Number(b.amount) / 1e6} USDC</b> from <code>${decodeAddress(b.signer.payload)}</code><br>to <code>${decodeAddress(b.recipient.payload)}</code></p>
<p>paymentId (mandate hash)<br><code style="word-break:break-all">${p.paymentId}</code></p>
${p.txHash ? `<p>settlement tx<br>${paymentNet.txUrl(p.txHash) ? `<a href="${paymentNet.txUrl(p.txHash)}">` : ""}<code style="word-break:break-all">${p.txHash}</code>${paymentNet.txUrl(p.txHash) ? "</a>" : ""}</p>` : ""}
${p.decision ? `<p>Verifier: <b>${p.decision.outcomeClass}</b> — ${p.decision.reason}</p>` : ""}
<h3>Decision trace</h3><ol>${p.trace.map((t) => `<li>${t.step} <small style="color:#888">${t.at}</small></li>`).join("")}</ol></body>`);
  });

  return { router, chainInfo };
}
