// What each seller agent delivers once it has been paid.
import { registryNet } from "../chain.js";

export interface Deliverable {
  kind: "svg" | "text" | "json";
  title: string;
  content: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Split a brief like "Diwali sale: 50% off when you pay with stablecoins" into headline + subline. */
export function posterLines(brief: string) {
  const clean = brief.replace(/^(make|design|create)\s+(me\s+)?(a\s+)?(poster|graphic)\s*(for|about|:)?\s*/i, "").trim();
  const [head, ...rest] = clean.split(/[:\-–—]\s*/);
  return { headline: (head || "Launch day").slice(0, 28), subline: (rest.join(" ") || "Powered by AllScale").slice(0, 56) };
}

function poster(brief: string, cheap: boolean): Deliverable {
  const { headline, subline } = posterLines(brief);
  const svg = cheap
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><rect width="600" height="800" fill="#ddd"/><text x="300" y="400" font-size="40" text-anchor="middle" font-family="Comic Sans MS">${esc(headline)}</text></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a18"/><stop offset=".55" stop-color="#d4145a"/><stop offset="1" stop-color="#3a0ca3"/></linearGradient>
<radialGradient id="glow" cx=".5" cy=".38" r=".5"><stop offset="0" stop-color="#ffd166" stop-opacity=".9"/><stop offset="1" stop-color="#ffd166" stop-opacity="0"/></radialGradient></defs>
<rect width="600" height="800" fill="url(#g)"/><circle cx="300" cy="300" r="260" fill="url(#glow)"/>
${Array.from({ length: 9 }, (_, i) => `<g transform="translate(${70 + i * 57} ${640 + (i % 2) * 18})"><path d="M0 0 q14 -38 28 0 z" fill="#ffd166"/><ellipse cx="14" cy="4" rx="18" ry="7" fill="#7b2cbf"/></g>`).join("")}
<text x="300" y="330" fill="#fff" font-size="64" font-weight="800" text-anchor="middle" font-family="Helvetica, Arial">${esc(headline)}</text>
<text x="300" y="395" fill="#fff" font-size="24" text-anchor="middle" font-family="Helvetica, Arial" opacity=".92">${esc(subline)}</text>
<text x="300" y="760" fill="#fff" font-size="16" text-anchor="middle" font-family="Helvetica, Arial" opacity=".75">designed by pixel.design · paid on HSK Chain</text></svg>`;
  return { kind: "svg", title: cheap ? "Poster (budget)" : "Poster", content: svg };
}

// Offline phrase table for the demo copy. A production Lingo would call a translation model.
const HINDI: Record<string, string> = {
  "diwali sale": "दिवाली सेल",
  "diwali": "दिवाली",
  "50% off when you pay with stablecoins": "स्टेबलकॉइन से भुगतान करने पर 50% की छूट",
  "50% off": "50% की छूट",
  "pay with stablecoins": "स्टेबलकॉइन से भुगतान करें",
  "powered by allscale": "AllScale द्वारा संचालित",
  "launch day": "लॉन्च का दिन",
  "shop now": "अभी खरीदें",
  "agents welcome": "एजेंटों का स्वागत है",
};

function translate(text: string): Deliverable {
  const lines = text.split(/\n|\s*\|\s*/).map((l) => l.trim()).filter(Boolean);
  const out = lines.map((l) => {
    const hit = HINDI[l.toLowerCase().replace(/[.!]$/, "")];
    return `${l}\n→ ${hit ?? "[offline demo: phrase not in Lingo's table]"}`;
  });
  return { kind: "text", title: "Hindi translation", content: out.join("\n\n") };
}

async function chainData(): Promise<Deliverable> {
  const [block, gasPrice] = await Promise.all([registryNet.client.getBlock(), registryNet.client.getGasPrice()]);
  return {
    kind: "json",
    title: `${registryNet.config.label} snapshot`,
    content: JSON.stringify(
      { network: registryNet.config.label, chainId: registryNet.config.chainId, block: Number(block.number), blockTime: new Date(Number(block.timestamp) * 1000).toISOString(), txCount: block.transactions.length, gasPriceGwei: Number(gasPrice) / 1e9 },
      null,
      2,
    ),
  };
}

function storyboard(brief: string): Deliverable {
  const { headline } = posterLines(brief);
  return {
    kind: "text",
    title: "Launch video storyboard",
    content: [`0–5s  Cold open: "${headline}"`, "5–15s  Product in action, agents paying agents", "15–25s  On-chain receipts ticking by on HSK Chain", "25–30s  End card: AgentPassport by AllScale"].join("\n"),
  };
}

export async function doWork(handle: string, task: string): Promise<Deliverable> {
  switch (handle) {
    case "pixel.design":
      return poster(task, false);
    case "ghost.design":
      return poster(task, true);
    case "lingo.translate":
      return translate(task);
    case "oracle.data":
      return chainData();
    case "studio.video":
      return storyboard(task);
    case "nova.agent":
      return {
        kind: "text",
        title: "Market research brief",
        content: [`Brief: ${task}`, "", "• Demand: stablecoin-paying shoppers up month over month in the target segment", "• Competitors: 3 incumbents, none accept agent payments", "• Recommendation: launch with a Diwali promotion and agent-friendly checkout", "", "— prepared by @nova.agent, paid via HSP"].join("\n"),
      };
    default:
      return { kind: "text", title: "Done", content: task };
  }
}
