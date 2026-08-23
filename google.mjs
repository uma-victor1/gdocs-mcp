// Shared Google auth + API clients for the gdocs MCP server.
//
// Credentials live outside the repo by default so a stray `git add -A` can never
// commit them. Override with GDOCS_MCP_HOME if you keep them elsewhere.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

export const HOME =
  process.env.GDOCS_MCP_HOME || path.join(homedir(), ".config", "gdocs-mcp");
export const CREDENTIALS_PATH = path.join(HOME, "credentials.json");
export const TOKEN_PATH = path.join(HOME, "token.json");

// Where this checkout actually lives, so the "run this" messages below are
// copy-pasteable no matter where the repo was cloned.
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTH_CMD = `cd "${PKG_DIR}" && npm run auth`;

// `documents` covers reading and batch-editing doc bodies.
// `drive` covers comment threads, markdown export, and in-place content upload.
export const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
];

export async function ensureHome() {
  await mkdir(HOME, { recursive: true });
}

async function loadSavedClient() {
  let raw;
  try {
    raw = await readFile(TOKEN_PATH, "utf8");
  } catch {
    return null;
  }
  const creds = JSON.parse(raw);
  return google.auth.fromJSON(creds);
}

export async function saveClient(client) {
  const raw = await readFile(CREDENTIALS_PATH, "utf8");
  const keys = JSON.parse(raw);
  const key = keys.installed || keys.web;
  await ensureHome();
  await writeFile(
    TOKEN_PATH,
    JSON.stringify(
      {
        type: "authorized_user",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

/**
 * Returns an authorised client, or throws a message that tells the human
 * exactly what to run. The server never opens a browser on its own — an MCP
 * server launched by Claude Code has nowhere to show a consent screen.
 */
export async function getAuth() {
  const client = await loadSavedClient();
  if (client) return client;
  throw new Error(
    `Not authorised yet. Run this once in your terminal:\n\n` +
      `  ${AUTH_CMD}\n\n` +
      `Expected token at ${TOKEN_PATH}`,
  );
}

export async function clients() {
  const auth = await getAuth();
  return {
    auth,
    docs: google.docs({ version: "v1", auth }),
    drive: google.drive({ version: "v3", auth }),
  };
}

const REAUTH =
  `Re-authorise:\n\n  ${AUTH_CMD}\n\n` +
  `Note: while the OAuth consent screen is in "Testing", Google expires the\n` +
  `refresh token every 7 days. This is expected, not a bug.`;

/**
 * Google's errors are verbose and bury the actionable part. Translate the three
 * that actually happen into instructions.
 */
export function explain(err) {
  const msg = String(err?.message ?? err);
  const data = err?.response?.data;
  const reason = data?.error ?? data?.error?.status ?? "";

  if (msg.includes("invalid_grant") || reason === "invalid_grant") {
    return `Authorisation expired or revoked.\n\n${REAUTH}`;
  }
  if (msg.includes("accessNotConfigured") || msg.includes("has not been used in project")) {
    return (
      `The Google Docs API or Google Drive API is not enabled on this Cloud project.\n\n` +
      `Enable both at APIs & Services > Library, wait a minute, then retry.\n\n${msg}`
    );
  }
  if (err?.code === 403 || err?.status === 403) {
    return `Google refused the request (403). Check the doc is shared with the authorised account.\n\n${msg}`;
  }
  if (err?.code === 404 || err?.status === 404) {
    return `No such document, or the authorised account cannot see it.\n\n${msg}`;
  }
  return msg;
}

/** Accepts a bare fileId or any Google Docs URL and returns the fileId. */
export function toFileId(input) {
  const s = String(input).trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  const q = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (q) return q[1];
  return s;
}
