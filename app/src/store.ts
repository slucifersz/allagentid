// Small JSON file store for agent keys and local deployment addresses. Agent wallets are
// custodial (held by the server) for the demo.
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { DATA_DIR } from "./config.js";

interface StoreShape {
  agentKeys: Record<string, `0x${string}`>;
  ownerKey?: `0x${string}`;
  deployments: Record<string, { registry: `0x${string}`; token: `0x${string}` }>;
}

const FILE = path.join(DATA_DIR, "state.json");

function load(): StoreShape {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { agentKeys: s.agentKeys ?? {}, ownerKey: s.ownerKey, deployments: s.deployments ?? {} };
  } catch {
    return { agentKeys: {}, deployments: {} };
  }
}

const state = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export const store = {
  agentKey(handle: string) {
    if (!state.agentKeys[handle]) {
      state.agentKeys[handle] = generatePrivateKey();
      save();
    }
    return state.agentKeys[handle];
  },
  ownerKey() {
    if (!state.ownerKey) {
      state.ownerKey = generatePrivateKey();
      save();
    }
    return state.ownerKey;
  },
  deployment(chainId: number) {
    return state.deployments[String(chainId)];
  },
  setDeployment(chainId: number, d: { registry: `0x${string}`; token: `0x${string}` }) {
    state.deployments[String(chainId)] = d;
    save();
  },
};
