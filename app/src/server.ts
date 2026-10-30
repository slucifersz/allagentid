import { ensureContractsBuilt } from "./bootstrap.js";

ensureContractsBuilt();
await import("./app.js");
