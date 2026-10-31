// stdio entry for Claude Desktop. Needs the AllScale Agent ID server running.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./mcp.js";

const base = process.env.AGENTID_URL ?? "http://localhost:4300";
await buildMcpServer(base).connect(new StdioServerTransport());
