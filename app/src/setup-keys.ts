// One-time setup for live mode: creates the operator wallet and the agent wallets, writes
// .env, and prints what has to be funded.
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BUYER, SELLERS } from "./agents/catalog.js";
import { ROOT } from "./config.js";
import { store } from "./store.js";

const envPath = path.join(ROOT, ".env");
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "";
const set = (k: string, v: string) => {
  env = new RegExp(`^${k}=`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
};

if (!get("OPERATOR_PRIVATE_KEY")) set("OPERATOR_PRIVATE_KEY", generatePrivateKey());
fs.writeFileSync(envPath, env, { mode: 0o600 });

const operator = privateKeyToAccount(get("OPERATOR_PRIVATE_KEY") as `0x${string}`).address;
const wallets = [BUYER.handle, ...SELLERS.map((s) => s.handle)].map((h) => [h, privateKeyToAccount(store.agentKey(h)).address] as const);

console.log(`
.env written: ${envPath}

1) HSK Chain MAINNET: fund the operator with a little HSK for gas
   (deploys the PassportRegistry, issues passports, records settlements):
   ${operator}

2) HSK Chain TESTNET (HSP sandbox): give the buyer agent test HSK for gas and test USDC.
   It settles payments from its own wallet. Use the sandbox faucet, or: npm run faucet
   ${wallets[0][1]}  (@${wallets[0][0]})

3) Put HSP_API_KEY (from the sandbox /register page) into .env.

Seller agent wallets (they receive payments; no funding needed):
${wallets.slice(1).map(([h, a]) => `   @${h.padEnd(16)} ${a}`).join("\n")}
`);
