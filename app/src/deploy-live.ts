// Deploy PassportRegistry to REGISTRY_NETWORK (HSK mainnet by default) with the operator
// key, then save REGISTRY_ADDRESS to .env. Passports are issued when the server starts.
import fs from "node:fs";
import path from "node:path";
import { ensureContractsBuilt } from "./bootstrap.js";
import { ROOT, live } from "./config.js";

ensureContractsBuilt();
const { registryNet, registryArtifact } = await import("./chain.js");

if (!live.operatorKey) throw new Error("OPERATOR_PRIVATE_KEY missing; run npm run setup:keys");
const w = registryNet.wallet(live.operatorKey as `0x${string}`);
const gas = await registryNet.client.getBalance({ address: w.account.address });
console.log(`Deploying to ${registryNet.config.label} (chain ${registryNet.config.chainId}) from ${w.account.address}, balance ${Number(gas) / 1e18} HSK`);
if (gas === 0n) throw new Error("operator has no HSK for gas");

const hash = await w.deployContract({ abi: registryArtifact.abi, bytecode: registryArtifact.bytecode } as never);
const address = (await registryNet.client.waitForTransactionReceipt({ hash })).contractAddress!;
console.log(`PassportRegistry deployed: ${address}\n${registryNet.addressUrl(address)}`);

const envPath = path.join(ROOT, ".env");
let env = fs.readFileSync(envPath, "utf8");
env = /^REGISTRY_ADDRESS=/m.test(env) ? env.replace(/^REGISTRY_ADDRESS=.*$/m, `REGISTRY_ADDRESS=${address}`) : `${env.trimEnd()}\nREGISTRY_ADDRESS=${address}\n`;
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log("Saved REGISTRY_ADDRESS to .env");
