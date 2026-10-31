// Seller agents speak A2A (JSON-RPC message/send):
//   1st message (task brief) -> task "input-required" + a quote from the active HSP rail
//                               (a signed payment requirement, or a HashKey Merchant Cart Mandate)
//   2nd message (payment id) -> seller verifies the payment through HSP and on-chain itself
//                               -> task "completed" + artifact
import crypto from "node:crypto";
import express from "express";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PUBLIC_URL } from "../config.js";
import { emit } from "../events.js";
import type { Quote, Rail } from "../rails.js";
import { SELLERS, sellerByHandle, type SellerSpec } from "./catalog.js";
import { doWork } from "./work.js";

export const QUOTE_KEY = "agentid.quote";
export const PAYMENT_KEY = "agentid.payment";

interface Part {
  kind: "text" | "data";
  text?: string;
  data?: Record<string, unknown>;
}
interface Message {
  role: "user" | "agent";
  parts: Part[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}
interface Task {
  id: string;
  contextId: string;
  kind: "task";
  status: { state: "input-required" | "completed" | "failed"; message?: Message; timestamp: string };
  artifacts?: { artifactId: string; name: string; parts: Part[] }[];
}

export const agentUrl = (handle: string) => `${PUBLIC_URL}/agents/${handle}`;

export function agentCard(s: SellerSpec, wallet: Hex, rail: Rail) {
  return {
    protocolVersion: "0.3.0",
    name: s.name,
    description: s.blurb,
    url: `${agentUrl(s.handle)}/a2a`,
    version: "1.0.0",
    provider: { organization: "AllScale Agent ID demo agents", url: PUBLIC_URL },
    capabilities: { streaming: false, extensions: [{ uri: "https://hashfans.io/docs?id=HSP", description: `Accepts payments through HSP (${rail.label})`, params: { roles: ["merchant"] } }] },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "image/svg+xml", "application/json"],
    skills: [{ ...s.skill, examples: [], pricing: { amount: s.priceUsd, currency: "USD", settlement: `USDC via HSP (${rail.label})`, per: s.payPerCall ? "call" : "task" } }],
    agentid: { handle: s.handle, wallet },
  };
}

const msg = (parts: Part[], taskId: string, contextId: string): Message => ({ role: "agent", parts, messageId: crypto.randomUUID(), taskId, contextId });

export function createSellerRouter(deps: { rail: Rail; agentKey: (handle: string) => Hex }) {
  const router = express.Router();
  const walletOf = (h: string) => privateKeyToAccount(deps.agentKey(h)).address;
  const tasks = new Map<string, { task: Task; seller: SellerSpec; brief: string; quote: Quote }>();
  const consumed = new Set<string>();

  router.get("/", (_req, res) => res.json(SELLERS.map((s) => agentCard(s, walletOf(s.handle), deps.rail))));

  router.get("/:handle/.well-known/agent-card.json", (req, res) => {
    const s = sellerByHandle(req.params.handle);
    if (!s) return res.status(404).json({ error: "unknown agent" });
    res.json(agentCard(s, walletOf(s.handle), deps.rail));
  });

  router.post("/:handle/a2a", async (req, res) => {
    const { id, method, params } = req.body ?? {};
    const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
    const s = sellerByHandle(req.params.handle);
    if (!s) return error(-32001, "unknown agent");
    if (method !== "message/send") return error(-32601, "method not found");
    const m = params?.message as Message;
    if (!m?.parts) return error(-32602, "message.parts required");
    try {
      const paid = m.parts.find((p) => p.kind === "data" && p.data?.[PAYMENT_KEY])?.data?.[PAYMENT_KEY] as { proofId: string } | undefined;
      if (paid && m.taskId) return reply(await fulfil(m.taskId, paid.proofId));
      const brief = m.parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n").trim();
      return reply(await quote(s, brief));
    } catch (e) {
      return error(-32000, (e as Error).message);
    }
  });

  async function quote(s: SellerSpec, brief: string): Promise<Task> {
    const taskId = crypto.randomUUID();
    const contextId = crypto.randomUUID();
    const q = await deps.rail.createQuote(s, deps.agentKey(s.handle));
    const task: Task = {
      id: taskId,
      contextId,
      kind: "task",
      status: {
        state: "input-required",
        timestamp: new Date().toISOString(),
        message: msg(
          [
            { kind: "text", text: `Quote from ${s.handle}: ${s.skill.name} for ${q.amountUsd} USDC${s.payPerCall ? " per call" : ""}. Pay through HSP and send me the payment id.` },
            { kind: "data", data: { [QUOTE_KEY]: q } },
          ],
          taskId,
          contextId,
        ),
      },
    };
    tasks.set(taskId, { task, seller: s, brief, quote: q });
    emit({ kind: "mandate", title: `${s.handle} quoted ${q.amountUsd} USDC`, detail: q.rail === "hsp-merchant" ? `HSP order ${q.quoteId} (Cart Mandate) · pay to ${q.recipient}` : `signed payment requirement · pay to ${q.recipient}` });
    return task;
  }

  async function fulfil(taskId: string, proofId: string): Promise<Task> {
    const st = tasks.get(taskId);
    if (!st) throw new Error("unknown task");
    if (st.task.status.state === "completed") return st.task;
    if (consumed.has(proofId)) throw new Error("payment already used for another task");
    await deps.rail.verifyPaid(st.quote, proofId); // throws unless HSP and the chain agree it settled to us
    consumed.add(proofId);

    const out = await doWork(st.seller.handle, st.brief);
    st.task.status = { state: "completed", timestamp: new Date().toISOString(), message: msg([{ kind: "text", text: `Payment ${proofId.slice(0, 14)}… verified. Here you go.` }], taskId, st.task.contextId) };
    st.task.artifacts = [{ artifactId: crypto.randomUUID(), name: out.title, parts: [{ kind: "data", data: { deliverable: out } }] }];
    emit({ kind: "deliver", title: `${st.seller.handle} verified the payment and delivered: ${out.title}`, data: { deliverable: out, seller: st.seller.handle } });
    return st.task;
  }

  return router;
}
