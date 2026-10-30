# AgentPassport by AllScale

**AllScale's one-stop financial identity for AI agents.** A single onboarding gives an agent five things:

| | What the agent gets | Status in this build |
|---|---|---|
| 🪪 **Identity** | An on-chain passport on HSK Chain: unique handle, verification tier (unverified / owner KYC / verified human), owner | ✅ live contract |
| 💰 **Account & balance** | A stablecoin balance it can read and spend. The AllScale USD account (AllScale VA) comes next | ✅ USDC balance · AllScale VA: coming soon |
| ⚡ **Receive & pay** | Settlement with other agents and merchants **through HSP on HSK Chain** | ✅ real (the Track 2 part) |
| 🛡 **Spending rules** | Owner-set per-payment and daily limits, and the minimum tier of counterparties. Over the limit, the owner approves | ✅ on-chain, enforced before every payment |
| 💳 **US card (AgentCard)** | A long-term Visa card plus single-use cards per order, usable at any card-accepting merchant, under the same limits | 🎬 **demo only, coming soon via an issuing partner. No real card is issued** |

Built for the **HSK Chain Horizon Hackathon · Track 2: Agent Payments & A2A Settlement**. A2A settlement through HSP is the real, on-chain capability inside the passport.

```
 Owner (Claude / Grok / Muse via MCP)                          AgentPassport (HSK Chain)
   │                                                           identity · tier · rules · ledger
   ▼                                                                     ▲
 nova.agent ── get_my_account ──► identity, balance, rules, card          │ recordSettlement
   │                                                                     │
   ├─ receive: atlas.client pays nova via HSP ───────────────────────────┤
   ├─ pay:     quote verified → passports + rules checked on-chain        │
   │           ✗ unverified payee → refuse   ✗ over limit → owner approves│
   │           → HSP (mandate / order) → USDC settles on HSK ─────────────┘
   └─ card:    one-time card for a merchant order, within the same rules (demo)
```

## What's in the repo

| Path | What it is |
|---|---|
| `contracts/src/PassportRegistry.sol` | Passports: handle, owner, tier (attested by AllScale), spending policy, `checkPayment`, settlement ledger keyed by HSP paymentId. 6 Foundry tests. |
| `contracts/src/MockUSDC.sol` | Test stablecoin (EIP-3009): the local chain, and the HSK testnet fallback. Never deployed to mainnet |
| `app/src/hsp/wire.ts` | HSP wire v1: the 11-field EIP-712 Mandate, `eip712-eoa.v1` signer profile, capability hashing |
| `app/src/hsp/coordinator.ts` | HSP Coordinator client: `/chains`, `POST /payments`, `/observe`, `GET /payments/:id`, explain links |
| `app/src/hsp/emulator.ts` | Local Coordinator emulator: verifies the mandate signature, observes the Transfer log, runs the capability check, signs a receipt |
| `app/src/agents/seller.ts` | Seller agents over A2A (`/.well-known/agent-card.json`, JSON-RPC `message/send`) with signed payment requirements |
| `app/src/agents/payer.ts` | The AllScale pay agent: verify → passport/policy check → HSP mandate → transfer → observe → record → collect |
| `app/src/mcp.ts` | MCP tools: `get_my_account`, `issue_one_time_card` (demo), `find_agents`, `get_passport`, `issue_passport`, `set_spending_policy`, `hire_agent` (pay), `approve_payment`, `recent_activity` |
| `app/src/cards.ts` | AgentCard **simulation**: long-term and single-use cards under the passport's limits; no card rails touched |
| `app/public/index.html` | Dashboard: the agent's account (identity, balance, rules, card), receive / pay, payments with HSP records, live activity |
| `docs/` | Submission text, pitch outline, video script, HSP sandbox checklist |

## Run it locally (no accounts or keys needed)

Requires Node 20+ and [Foundry](https://getfoundry.sh).

```bash
cd app && npm install && npm run dev
```

Open http://localhost:4300 and click **Run the demo**:
1. **Passport:** `@nova.agent` has its identity (Owner KYC), USDC balance, rules (≤5/payment, ≤15/day) and card.
2. **Read:** Nova reads its own identity and balance (`get_my_account`).
3. **Receive:** `@atlas.client` pays Nova **3 USDC through HSP** for a market brief.
4. **Pay:** Nova pays `@pixel.design` **2 USDC through HSP**. It refuses `@ghost.design` (unverified). It holds `@studio.video`'s 20 USDC (over limit) for the owner's approval.
5. **Card (demo):** a one-time Visa card for a $4.50 merchant order, issued within the same limits. A $40 card is refused.
6. *"One AllScale onboarding: identity, an account, payments and a card."*

Local mode starts anvil, deploys the contracts, issues the passports and funds the agents. It runs an HSP emulator for whichever rail `HSP_MODE` selects. Try `HSP_MODE=agentic npm run dev` for the HSP Agentic Payment flow against a local copy of HSP's MCP server, or `HSP_MODE=merchant npm run dev` for the HashKey Merchant rail: add `HSP_PAY_MANDATE_URL=on` and the agent pays by API; without it, you pay at the local HSP checkout.

### Connect it to Claude / Grok / Muse (MCP)

- Remote (streamable HTTP): `http://localhost:4300/mcp`. Public clients need the server deployed at a public URL.
- Claude Desktop (stdio):

```json
{ "mcpServers": { "agentpassport": { "command": "npx", "args": ["tsx", "/ABSOLUTE/PATH/agentpassport/app/src/mcp-stdio.ts"], "env": { "AGENTPASSPORT_URL": "http://localhost:4300" } } } }
```

Then ask: *"What's in my account?"*, *"Pay pixel.design for a Diwali poster"*, or *"Get me a one-time card for a $12 order"*.

## Run it live (HSK Chain + the hackathon HSP sandbox)

Passports live on **HSK Chain mainnet**, as the hackathon rules require. Payments settle in real USDC on `PAYMENT_NETWORK`: HSK testnet by default, or `hashkey` for mainnet.

### HSP rails (`HSP_MODE`)

The Track 2 text points at two HSP surfaces, so the app supports both and switches by config:

| `HSP_MODE` | What pays | Needs |
|---|---|---|
| `agentic` | **HSP Agentic Payment** (the hackathon's HSP QA MCP server, `mcp-qa.hashkeymerchant.com`). The seller agent opens an HSP order with `create_order` (`pay_to` = its passport wallet, `merchant_name` = `AllScale`). The pay agent checks both passports and its rules, calls `prepare_payment`, checks the EIP-712 data and its balance, signs with its own wallet, then `finalize_payment` → `submit_payment`. HSP's Gateway broadcasts; the agent polls `query_payment` until `payment-safe` / `payment-finalized` with `attribution_verified`. | Our egress IP on HSP's QA allowlist; payer wallets funded with the token `get_chain_config` names |
| `merchant` | **HashKey Merchant gateway** (https://hashkey-merchant.github.io). Each seller quote is a real HSP order: a Cart Mandate signed ES256K with the key in `keys/`, with `pay_to` set to the seller's passport wallet. The buyer verifies it. If `HSP_PAY_MANDATE_URL` is set, the agent signs an x402 / EIP-3009 Payment Mandate and submits it by API. Otherwise the owner pays at HSP's hosted checkout, and the job finishes once HSP reports the payment settled. | `HSP_APP_KEY`, `HSP_APP_SECRET` from the merchant console (QA host for testnet) |
| `coordinator` | **HSP Settlement Protocol** on a hosted Coordinator: signed EIP-712 mandate → transfer from the agent's own wallet → observe → `SETTLED` | `HSP_COORDINATOR_URL`, `HSP_API_KEY` |
| `builtin` | The same Settlement Protocol flow against the built-in Coordinator, observing **real** USDC transfers on HSK Chain | nothing; this is the fallback |

> **Status (Oct 29).** The HSP sandbox Coordinator from an earlier edition (`hsp-hackathon.hashkeymerchant.com`) no longer resolves. The Mumbai track text links the HashKey Merchant API instead. We have asked the organizers three things: where to send merchant onboarding, whether an agent may submit the Payment Mandate by API, and whether a Mumbai sandbox Coordinator exists. Until they answer, `builtin` runs everything on real HSK transfers, and `merchant` is ready once app credentials arrive.

**Fallback setup (works today, no HSP credentials needed):** passports on HSK mainnet, payments through the built-in HSP Coordinator on HSK testnet, with a test USDC we deploy ourselves (clearly labelled "test USDC" in the dashboard).

```bash
cd app
npm run setup:keys          # operator wallet + agent wallets → .env and data/
# 1. send ~0.1 mainnet HSK and some testnet HSK (faucet) to the operator address it prints
npm run deploy:passports    # PassportRegistry → HSK mainnet, saves REGISTRY_ADDRESS
npm run deploy:test-usdc    # test USDC (EIP-3009) → HSK testnet, saves STABLECOIN_ADDRESS + TEST_STABLECOIN=1
npm run live                # issues passports, tops up the paying agents with test USDC and gas, serves the dashboard + MCP
```

**HSP Agentic Payment (HSP QA):** once HSP confirms the allowlist for the server's egress IP, run the one-shot check, then switch the rail:

```bash
npm run check:hsp-mcp       # health, the 8 tools and their live schemas, get_chain_config, agent balances; no orders, no retries
# .env: HSP_MODE=agentic, PAYMENT_NETWORK=<network get_chain_config offers>, remove STABLECOIN_ADDRESS / TEST_STABLECOIN
# the team funds nova.agent and atlas.client with that exact token (the guide forbids the agent from funding itself)
npm run live
```

**Other HSP rails:** set `HSP_APP_KEY` / `HSP_APP_SECRET` (merchant rail, plus `HSP_PAY_MANDATE_URL` once confirmed) or `HSP_COORDINATOR_URL` / `HSP_API_KEY` (coordinator rail) in `.env`. To pay in the official USDC instead of the test token, remove `STABLECOIN_ADDRESS` and `TEST_STABLECOIN` and fund `nova.agent` and `atlas.client` with gas + ~25 USDC. Then:

```bash
npm run check:hsp           # smoke-tests the configured rail against the real HSP endpoint
npm run live
```

### Real vs. emulated

| | Local (`npm run dev`) | Live (`npm run live`) |
|---|---|---|
| PassportRegistry, policy checks, ledger | ✅ real contract (anvil) | ✅ HSK Chain mainnet |
| A2A agent cards, signed quotes | ✅ | ✅ |
| HSP mandate (EIP-712, wire v1) | ✅ real signature | ✅ same code, real Coordinator |
| USDC settlement from the agent wallet | ✅ local token | ✅ HSK testnet: our test USDC (fallback) or official USDC |
| HSP | emulators for every rail (`HSP_MODE=builtin\|coordinator\|merchant\|agentic`) | `agentic`: HSP QA MCP server · `builtin`: real HSK transfers · `coordinator`: hosted Coordinator · `merchant`: HashKey Merchant gateway |
| AgentCard | simulation, labelled demo | simulation, labelled demo (coming soon via issuing partner) |

The mandate encoding follows the HSP wire v1 field set used by the reference SDK, as other hackathon teams vendored it. `npm run check:hsp` confirms that the Coordinator's `paymentId` equals our local mandate hash.

## Security notes

- Agent wallets are custodial (held by the AllScale server) for the demo. Keys live in `app/data/state.json` (git-ignored).
- The policy is enforced by the pay agent before it signs. The contract is the source of truth it reads and the audit log it writes. Hard on-chain enforcement through a smart-account spending module is on the roadmap.
- Sellers never trust the buyer's word. They fetch the payment from HSP, recompute the mandate hash, check the recipient and amount, and find the Transfer on-chain before delivering.
