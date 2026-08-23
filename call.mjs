#!/usr/bin/env node
// Invoke a tool without going through Claude Code. Handy for debugging.
//   node call.mjs <tool> '<json-args>'
//   node call.mjs read_comments '{"doc":"https://docs.google.com/document/d/FILEID/edit"}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, argsJson = "{}"] = process.argv.slice(2);
if (!name) {
  console.error("usage: node call.mjs <tool> '<json-args>'");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./server.mjs", import.meta.url).pathname],
});
const client = new Client({ name: "cli", version: "1.0.0" });
await client.connect(transport);

const res = await client.callTool({ name, arguments: JSON.parse(argsJson) });
for (const c of res.content ?? []) if (c.type === "text") console.log(c.text);
await client.close();
process.exit(res.isError ? 1 : 0);
