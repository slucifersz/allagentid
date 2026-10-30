// The demo cast: Nova (the owner's agent), a client agent that pays Nova, and the agents
// Nova can pay.

export interface SellerSpec {
  handle: string;
  name: string;
  tier: number; // verification tier the attester assigns
  skill: { id: string; name: string; description: string; tags: string[] };
  priceUsd: string;
  /** Reusable HSP order: one cart mandate, a payment per call. */
  payPerCall?: boolean;
  blurb: string;
}

export const BUYER = {
  handle: "nova.agent",
  name: "Nova",
  tier: 1,
  policy: { perTxUsd: "5", dailyUsd: "15", minTier: 1 },
  fundUsd: "50",
};

export const SELLERS: SellerSpec[] = [
  {
    handle: "pixel.design",
    name: "Pixel",
    tier: 2,
    priceUsd: "2",
    blurb: "Poster and social graphics in seconds",
    skill: { id: "poster", name: "Poster design", description: "Designs a promo poster from a one-line brief", tags: ["design", "poster", "image"] },
  },
  {
    handle: "lingo.translate",
    name: "Lingo",
    tier: 1,
    priceUsd: "1",
    blurb: "Marketing copy in 12 Indian languages",
    skill: { id: "translate", name: "Translation", description: "Translates short marketing copy (Hindi, Marathi, Tamil…)", tags: ["translate", "language", "hindi"] },
  },
  {
    handle: "oracle.data",
    name: "Oracle",
    tier: 1,
    priceUsd: "0.1",
    payPerCall: true,
    blurb: "Live HSK Chain data, paid per call",
    skill: { id: "chain-data", name: "Chain data", description: "Latest HSK Chain block, gas price and network stats", tags: ["data", "chain", "api"] },
  },
  {
    handle: "studio.video",
    name: "Studio",
    tier: 2,
    priceUsd: "20",
    blurb: "30-second launch videos",
    skill: { id: "video", name: "Launch video", description: "Storyboards and renders a 30-second launch video", tags: ["video", "launch"] },
  },
  {
    handle: "ghost.design",
    name: "Ghost",
    tier: 0,
    priceUsd: "0.5",
    blurb: "Cheap posters, no questions asked",
    skill: { id: "poster", name: "Poster design", description: "Posters at a quarter of the price", tags: ["design", "poster", "cheap"] },
  },
];

/** What Nova itself sells, so other agents can pay it (the "receive" side). */
export const NOVA_SERVICE: SellerSpec = {
  handle: "nova.agent",
  name: "Nova",
  tier: 1,
  priceUsd: "3",
  blurb: "Market research briefs",
  skill: { id: "research", name: "Market research brief", description: "A one-page market brief", tags: ["research", "brief"] },
};

/** A client agent with its own passport that pays Nova. */
export const CLIENT = {
  handle: "atlas.client",
  name: "Atlas",
  tier: 2,
  policy: { perTxUsd: "10", dailyUsd: "50", minTier: 1 },
  fundUsd: "50",
};

export const sellerByHandle = (h: string) => [...SELLERS, NOVA_SERVICE].find((s) => s.handle === h);
