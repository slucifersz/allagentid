// One-shot check of the HSP Agentic Payment MCP server (run once after HSP confirms the
// allowlist; it does not retry and creates no orders): health, the eight tools and their live
// input schemas, get_chain_config, and whether our paying agents hold the token it names.
import { privateKeyToAccount } from "viem/accounts";
import { BUYER, CLIENT } from "./agents/catalog.js";
import { agentic, PAYMENT_NET } from "./config.js";
import { HspAgentic, HSP_AGENTIC_TOOLS } from "./hsp/agentic.js";
import { store } from "./store.js";

const url = process.argv[2] ?? agentic.url;
console.log(`HSP Agentic Payment MCP: ${url}`);
const health = await fetch(new URL("health", url.endsWith("/") ? url : `${url}/`)).then(
  async (r) => `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`,
  (e) => `unreachable: ${(e as Error).message}`,
);
console.log(`Health: ${health}`);

const hsp = new HspAgentic(url);
try {
  const tools = await hsp.tools();
  console.log(`\nTools (${tools.length}):`);
  for (const t of tools) {
    const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
    const req = (t.inputSchema as { required?: string[] }).required ?? [];
    console.log(`  ${HSP_AGENTIC_TOOLS.includes(t.name as never) ? "✓" : " "} ${t.name}(${props.map((p) => (req.includes(p) ? p : `${p}?`)).join(", ")})`);
  }
  if (process.env.VERBOSE) console.log(JSON.stringify(tools, null, 2));

  const { raw, tokens } = await hsp.chainConfig();
  console.log(`\nget_chain_config:\n${JSON.stringify(raw, null, 2)}`);
  console.log(`\nPayable tokens:`);
  for (const t of tokens) console.log(`  ${t.network} (${t.chainId}) ${t.symbol} ${t.address} · ${t.decimals} dp · ${t.protocol}${t.chainId === PAYMENT_NET.chainId ? "  ← PAYMENT_NETWORK" : ""}`);

  const pick = tokens.find((t) => t.chainId === PAYMENT_NET.chainId && t.symbol.toUpperCase() === agentic.token.toUpperCase());
  if (!pick) {
    console.log(`\n✗ No ${agentic.token} on PAYMENT_NETWORK ${PAYMENT_NET.label} (${PAYMENT_NET.chainId}); set PAYMENT_NETWORK / HSP_TOKEN to an offered pair.`);
  } else {
    const { stable } = await import("./chain.js");
    console.log(`\nUsing ${pick.symbol} ${pick.address} on ${PAYMENT_NET.label} (${pick.protocol})`);
    for (const h of [BUYER.handle, CLIENT.handle]) {
      const a = privateKeyToAccount(store.agentKey(h)).address;
      console.log(`  @${h} ${a}: ${await stable.balance(pick.address as `0x${string}`, a)} ${pick.symbol}`);
    }
    if (pick.protocol === "permit2") console.log("  Note: permit2 needs a one-time Permit2 approval from each payer wallet, done by the team, not the agent.");
  }
  console.log(`\nmerchant_name for orders and queries: "${agentic.merchantName}"`);
} catch (e) {
  console.log(`\n✗ ${(e as Error).message}`);
  console.log("If HSP has not confirmed the allowlist for this machine's egress IP yet, wait for it; don't retry in a loop.");
  process.exitCode = 1;
}
process.exit();
