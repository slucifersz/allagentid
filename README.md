# AgentPassport by AllScale

**The financial identity layer for the agent economy.** AI agents are about to move more money than most companies, and today none of them has a name, an account or a spending limit. AgentPassport fixes that in one onboarding: identity, a balance, HSP payments with any other agent, owner-set guardrails, and a card for the rest of the world.

**Live on HSK Chain mainnet and the real HSP Gateway.** Every payment in the demo is a real HSP order, signed by the agent's own wallet, settled by HSP's Gateway, confirmed `payment-safe` with AllScale attribution verified, and written to both agents' passports on HSK mainnet. [See the transactions ↓](#proven-on-real-hsp)

| | What the agent gets | Status |
|---|---|---|
| 🪪 **Identity** | An on-chain passport on HSK Chain mainnet: unique handle, verification tier attested by AllScale (unverified / owner KYC / verified human), accountable owner | ✅ live on mainnet |
| 💰 **Account & balance** | A stablecoin balance the agent reads and spends on its own; AllScale USD accounts (VA) plug in next | ✅ live · AllScale VA next |
| ⚡ **Receive & pay** | Agent-to-agent settlement **through HSP**, on any network HSP serves, recorded on HSK Chain | ✅ live on HSP (Track 2 core) |
| 🛡 **Spending rules** | Per-payment and daily limits, minimum counterparty tier, owner approval above the limit, enforced on-chain before every payment | ✅ live on mainnet |
| 💳 **AgentCard** | A Visa card plus single-use numbers per order, usable at any card-accepting merchant, under the same limits | 🎬 preview, launching with our issuing partner |

Built for the **HSK Chain Horizon Hackathon · Track 2: Agent Payments & A2A Settlement**.

## Proven on real HSP

Four payments, all through the HSP Agentic Payment Gateway (team `AllScale`), each recorded on both passports on HSK Chain mainnet:

| Payment | HSP Gateway transfer | Passport record (HSK mainnet) |
|---|---|---|
| atlas.client → nova.agent · 3 USDC | [0x3d6d5d72…](https://sepolia.basescan.org/tx/0x3d6d5d72184dfc4b722cdff913f8a16fc4df9092947bff55a331986fe01b5cfe) | [0x7c22867a…](https://hsk.blockscout.com/tx/0x7c22867ac4149bd8eb2605429f6b198766a0971a74af71b1d391065a415c5664) |
| atlas.client → nova.agent · 3 USDC | [0xa648dd86…](https://sepolia.basescan.org/tx/0xa648dd86aa1b8cb21b0d76470d6b534676139b1cef595245abce7e57280b8a30) | [0x2541183f…](https://hsk.blockscout.com/tx/0x2541183fc35cfc2c6bf90ea41ad8a708e03b6a06606e00dc2109f0e411bb36b5) |
| nova.agent → pixel.design · 2 USDC | [0x2f0ea15c…](https://sepolia.basescan.org/tx/0x2f0ea15cdfece69b2d468b682e2de8b51c10b118969c5131d18997de428e83f1) | [0x990ba1cd…](https://hsk.blockscout.com/tx/0x990ba1cdc4649e62476277c36f435e834e20d29ea33aa0c1a89cf22e34f41255) |
| nova.agent → studio.video · 20 USDC, over the limit, owner-approved | [0x0b9614f1…](https://sepolia.basescan.org/tx/0x0b9614f15541a1cc67b42a345ccd9ff40cbdc80bbbd2508ae2eacd93ad2fc2f4) | [0xfb13bffd…](https://hsk.blockscout.com/tx/0xfb13bffd9cdd1fc89fe343608f5bdfeb4e05239d51e71a0bd565d6c8fa3e67ce) |

**Why the transfers are on Base Sepolia, not HSK testnet.** HSP QA serves USDC on several testnets, and its HSK testnet token (`0x8FE3cB71…53c6`) can only be minted by its issuer: there is no public faucet, and it hadn't been distributed to teams before the deadline (we asked the organizers). Rather than fake the settlement with our own token, we funded the agents with Base Sepolia USDC from Circle's public faucet, another network HSP QA serves, so every payment above runs through the real HSP Gateway end to end. Moving to HSK is configuration only: `PAYMENT_NETWORK=hashkey-testnet` once that token is funded, or `hashkey` on mainnet.

And the guardrails held: an unverified agent (`ghost.design`) was refused before any money moved. PassportRegistry: [`0x902186b2…cc71`](https://hsk.blockscout.com/address/0x902186b2e62469265d47158ca4b8e7664488cc71) on HSK mainnet.

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

AgentPassport speaks every HSP surface, from the Agentic Payment MCP server to the Merchant gateway and the Settlement Protocol:

| `HSP_MODE` | What pays | Needs |
|---|---|---|
| `agentic` | **HSP Agentic Payment** (the hackathon's HSP QA MCP server, `mcp-qa.hashkeymerchant.com`). The seller agent opens an HSP order with `create_order` (`pay_to` = its passport wallet, `merchant_name` = `AllScale`). The pay agent checks both passports and its rules, calls `prepare_payment`, checks the EIP-712 data and its balance, signs with its own wallet, then `finalize_payment` → `submit_payment`. HSP's Gateway broadcasts; the agent polls `query_payment` until `payment-safe` / `payment-finalized` with `attribution_verified`. | Our egress IP on HSP's QA allowlist; payer wallets funded with the token `get_chain_config` names |
| `merchant` | **HashKey Merchant gateway** (https://hashkey-merchant.github.io). Each seller quote is a real HSP order: a Cart Mandate signed ES256K with the key in `keys/`, with `pay_to` set to the seller's passport wallet. The buyer verifies it. If `HSP_PAY_MANDATE_URL` is set, the agent signs an x402 / EIP-3009 Payment Mandate and submits it by API. Otherwise the owner pays at HSP's hosted checkout, and the job finishes once HSP reports the payment settled. | `HSP_APP_KEY`, `HSP_APP_SECRET` from the merchant console (QA host for testnet) |
| `coordinator` | **HSP Settlement Protocol** on a hosted Coordinator: signed EIP-712 mandate → transfer from the agent's own wallet → observe → `SETTLED` | `HSP_COORDINATOR_URL`, `HSP_API_KEY` |
| `builtin` | The same Settlement Protocol flow against the built-in Coordinator, observing **real** USDC transfers on HSK Chain | nothing; this is the fallback |

Four rails, one agent: the pay agent, passports and guardrails are identical across all of them, and switching is a single env var.

**HSK-native rail (no HSP credentials needed):** passports on HSK mainnet, payments through the built-in HSP Coordinator with real transfers on HSK testnet, in a test USDC we deploy (labelled "test USDC" in the dashboard).

```bash
cd app
npm run setup:keys          # operator wallet + agent wallets → .env and data/
# 1. send ~0.1 mainnet HSK and some testnet HSK (faucet) to the operator address it prints
npm run deploy:passports    # PassportRegistry → HSK mainnet, saves REGISTRY_ADDRESS
npm run deploy:test-usdc    # test USDC (EIP-3009) → HSK testnet, saves STABLECOIN_ADDRESS + TEST_STABLECOIN=1
npm run live                # issues passports, tops up the paying agents with test USDC and gas, serves the dashboard + MCP
```

**HSP Agentic Payment (HSP QA), the setup behind the demo:** runs from our allowlisted server. Passports and the ledger stay on HSK mainnet; payments settle through HSP's Gateway on whichever network `get_chain_config` serves. The demo agents hold Base Sepolia USDC; `PAYMENT_NETWORK=hashkey-testnet` (or `hashkey` for mainnet) moves the same agents onto HSK with no code change.

```bash
PAYMENT_NETWORK=base-sepolia STABLECOIN_ADDRESS= TEST_STABLECOIN=0 npm run check:hsp-mcp   # 8 tools, live schemas, tokens, agent balances; no orders
# the team funds nova.agent and atlas.client with that USDC (the guide forbids the agent from funding itself); no gas needed, HSP advances it
npm run live:hsp            # HSP_MODE=agentic on Base Sepolia, dashboard on :4310
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
| USDC settlement from the agent wallet | ✅ local token | ✅ `live:hsp`: Base Sepolia USDC via HSP's Gateway · `live`: HSK testnet, our test USDC |
| HSP | emulators for every rail (`HSP_MODE=builtin\|coordinator\|merchant\|agentic`) | `agentic`: **real HSP QA MCP server, tested** · `builtin`: real HSK transfers · `coordinator`: hosted Coordinator · `merchant`: HashKey Merchant gateway |
| AgentCard | simulation, labelled demo | simulation, labelled demo (coming soon via issuing partner) |

The mandate encoding follows the HSP wire v1 field set used by the reference SDK, as other hackathon teams vendored it. `npm run check:hsp` confirms that the Coordinator's `paymentId` equals our local mandate hash.

## Security notes

- Agent wallets are custodial (held by the AllScale server) for the demo. Keys live in `app/data/state.json` (git-ignored).
- The policy is enforced by the pay agent before it signs. The contract is the source of truth it reads and the audit log it writes. Hard on-chain enforcement through a smart-account spending module is on the roadmap.
- Sellers never trust the buyer's word. They fetch the payment from HSP, recompute the mandate hash, check the recipient and amount, and find the Transfer on-chain before delivering.
