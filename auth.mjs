#!/usr/bin/env node
// One-time interactive OAuth. Run in a real terminal: npm run auth
import { authenticate } from "@google-cloud/local-auth";
import { access } from "node:fs/promises";
import { CREDENTIALS_PATH, TOKEN_PATH, SCOPES, saveClient, ensureHome } from "./google.mjs";

await ensureHome();

try {
  await access(CREDENTIALS_PATH);
} catch {
  console.error(
    `\nMissing OAuth client file.\n\n` +
      `Download it from Google Cloud Console (APIs & Services > Credentials >\n` +
      `OAuth client ID > Desktop app > Download JSON) and save it to:\n\n` +
      `  ${CREDENTIALS_PATH}\n`,
  );
  process.exit(1);
}

console.log("Opening your browser for Google consent...");
const client = await authenticate({ keyfilePath: CREDENTIALS_PATH, scopes: SCOPES });
if (!client.credentials.refresh_token) {
  console.error(
    "\nGoogle returned no refresh token. Revoke this app at\n" +
      "https://myaccount.google.com/permissions and run `npm run auth` again.\n",
  );
  process.exit(1);
}
await saveClient(client);
console.log(`\nAuthorised. Token saved to ${TOKEN_PATH} (mode 0600).`);
