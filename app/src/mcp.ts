// AllScale Agent ID MCP tools. They call the AllScale Agent ID HTTP API, so the same tools run over
// stdio (Claude Desktop) and streamable HTTP at /mcp (Grok, Muse, remote clients).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function buildMcpServer(baseUrl: string) {
  const server = new McpServer({ name: "allscale-agent-id", version: "0.1.0" });

  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
  const safe = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
    try {
      return text(await fn(a));
    } catch (e) {
      return { ...text(`Error: ${(e as Error).message}`), isError: true };
    }
  };

  server.registerTool(
    "get_my_account",
    {
      title: "My AllScale account",
      description: "Everything the agent's AllScale Agent ID gives it in one call: on-chain identity and tier, stablecoin balance, spending rules and today's spend, payment history, and its AgentCard (demo).",
      inputSchema: { handle: z.string().default("nova.agent").describe("Your agent's passport handle") },
    },
    safe(async ({ handle }: { handle: string }) => call("GET", `/api/accounts/${encodeURIComponent(handle)}`)),
  );

  server.registerTool(
    "issue_one_time_card",
    {
      title: "Issue a one-time card (demo)",
      description:
        "DEMO, not live: issue a single-use US virtual card (Visa) for one merchant order, so the agent can pay any card-accepting merchant. The passport's spending rules apply. Cards are coming soon via an issuing partner; no real card is created.",
      inputSchema: { handle: z.string().default("nova.agent"), merchant: z.string(), amount_usd: z.string() },
    },
    safe(async (a: { handle: string; merchant: string; amount_usd: string }) => call("POST", `/api/accounts/${encodeURIComponent(a.handle)}/cards`, { merchant: a.merchant, amountUsd: a.amount_usd })),
  );

  server.registerTool(
    "find_agents",
    {
      title: "Find agents to hire",
      description: "List agents that can be hired, with their skill, price, AllScale Agent ID handle and verification tier.",
      inputSchema: { skill: z.string().optional().describe("Filter by skill keyword, e.g. poster, translate, video, data") },
    },
    safe(async ({ skill }: { skill?: string }) => {
      const s = await call("GET", "/api/state");
      const sellers = s.passports.filter((p: { role: string }) => p.role === "seller");
      return skill ? sellers.filter((p: { skill: string; tags: string[] }) => `${p.skill} ${p.tags.join(" ")}`.toLowerCase().includes(skill.toLowerCase())) : sellers;
    }),
  );

  server.registerTool(
    "get_passport",
    {
      title: "Look up an AllScale Agent ID",
      description: "Read an agent's on-chain passport: owner, verification tier, spending policy, today's spend, balance and settlement history.",
      inputSchema: { handle: z.string().describe("Passport handle, e.g. nova.agent") },
    },
    safe(async ({ handle }: { handle: string }) => call("GET", `/api/passports/${encodeURIComponent(handle)}`)),
  );

  server.registerTool(
    "issue_passport",
    {
      title: "Issue a passport for a new agent",
      description: "Create a wallet for a new agent and register its AllScale Agent ID handle on-chain.",
      inputSchema: { handle: z.string().describe("3-32 chars: a-z, 0-9, '-' and '.'"), fund_usdc: z.string().optional().describe("Local mode only: test USDC to fund the agent with") },
    },
    safe(async (a: { handle: string; fund_usdc?: string }) => call("POST", "/api/passports", a)),
  );

  server.registerTool(
    "set_spending_policy",
    {
      title: "Set an agent's spending rules",
      description: "Owner sets how much the agent may pay per payment and per day, and the minimum verification tier of agents it may pay (0 unverified, 1 owner KYC, 2 verified human).",
      inputSchema: { handle: z.string(), per_payment_usdc: z.string(), daily_usdc: z.string(), min_payee_tier: z.number().int().min(0).max(2) },
    },
    safe(async (a: { handle: string; per_payment_usdc: string; daily_usdc: string; min_payee_tier: number }) =>
      call("POST", `/api/passports/${encodeURIComponent(a.handle)}/policy`, { perTxUsd: a.per_payment_usdc, dailyUsd: a.daily_usdc, minTier: a.min_payee_tier }),
    ),
  );

  server.registerTool(
    "hire_agent",
    {
      title: "Pay another agent for a task",
      description:
        "Send a task to another agent over A2A. It returns a signed quote; the pay agent verifies it, checks both passports and the spending policy, then pays in USDC through HSP (signed mandate, transfer from the agent's own wallet, verified by the HSP Coordinator) and returns the delivered work. If the payment is over the owner's limits it waits for owner approval.",
      inputSchema: { payer: z.string().default("nova.agent").describe("Your agent's passport handle"), seller: z.string().describe("Handle of the agent to hire"), task: z.string().describe("What you want done") },
    },
    safe(async (a: { payer: string; seller: string; task: string }) => call("POST", "/api/hire", a)),
  );

  server.registerTool(
    "approve_payment",
    {
      title: "Approve or decline a held payment",
      description: "Owner decision on a payment the pay agent held because it was over the spending policy.",
      inputSchema: { job_id: z.string(), approve: z.boolean() },
    },
    safe(async ({ job_id, approve }: { job_id: string; approve: boolean }) => call("POST", `/api/jobs/${job_id}/${approve ? "approve" : "decline"}`)),
  );

  server.registerTool(
    "recent_activity",
    { title: "Recent payments and jobs", description: "Recent hires, payments, rejections and on-chain settlements.", inputSchema: {} },
    safe(async () => (await call("GET", "/api/state")).jobs),
  );

  return server;
}
