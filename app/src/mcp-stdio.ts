// stdio entry for Claude Desktop. Needs the AgentPassport server running.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./mcp.js";

const base = process.env.AGENTPASSPORT_URL ?? "http://localhost:4300";
await buildMcpServer(base).connect(new StdioServerTransport());
