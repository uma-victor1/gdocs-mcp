// Verifies the server starts over stdio and advertises its tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./server.mjs", import.meta.url).pathname],
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`connected. ${tools.length} tools:`);
for (const t of tools) {
  console.log(`  ${t.name.padEnd(16)} ${Object.keys(t.inputSchema?.properties ?? {}).join(", ")}`);
}

// Confirm an unauthorised call fails with the instructional message, not a crash.
const res = await client.callTool({ name: "find_doc", arguments: { title_contains: "x" } });
const msg = res.content?.[0]?.text ?? "";
console.log(`\nauth-state check -> ${msg.split("\n")[0]}`);

await client.close();
