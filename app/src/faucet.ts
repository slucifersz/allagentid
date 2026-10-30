// Ask the HSP sandbox faucet for testnet gas + USDC for the buyer agent (or an address arg).
import { privateKeyToAccount } from "viem/accounts";
import { BUYER } from "./agents/catalog.js";
import { live } from "./config.js";
import { store } from "./store.js";

if (!live.coordinatorUrl && !live.faucetUrl) throw new Error("No HSP sandbox URL yet: set HSP_COORDINATOR_URL (and HSP_FAUCET_URL) in .env once the organizers share them");

const address = process.argv[2] ?? privateKeyToAccount(store.agentKey(BUYER.handle)).address;
const base = (live.faucetUrl || live.coordinatorUrl).replace(/\/$/, "");
const res = await fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
console.log(`POST ${base}/faucet for ${address}: HTTP ${res.status}`);
console.log(await res.text());
