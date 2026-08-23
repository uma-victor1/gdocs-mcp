# gdocs — Google Docs review loop for Claude Code

An MCP server that lets Claude Code read a Google Doc **and its comment threads**,
then write corrections back into the same Doc at the same URL.

Built for the loop where Markdown in a repo is the source of truth and Google Docs
is only the review surface. It removes the copy-paste round trip: no pasting the
draft into Docs, no pasting reviewer comments back into the terminal.

Installed at user scope, so it works in every project.

## Requirements

- Node 18+
- The `claude` CLI
- A Google account, and about 10 minutes in Google Cloud Console

## Install

```bash
git clone https://github.com/uma-victor1/gdocs-mcp.git
cd gdocs-mcp
./install.sh
```

That installs dependencies, verifies the server starts, and registers it with
Claude Code at user scope. Then do the two credential steps below yourself.

### 1. Google Cloud, once

1. Create a project: <https://console.cloud.google.com/projectcreate>
2. Enable **Google Docs API** and **Google Drive API** (APIs & Services > Library)
3. OAuth consent screen: user type **External** is fine for a personal account.
   Under *Audience*, add your own address as a **test user** — skipping this is
   the most common reason consent fails.
4. Credentials > Create credentials > OAuth client ID > **Desktop app** >
   Download JSON
5. Save it as `~/.config/gdocs-mcp/credentials.json`

Credentials live outside any repo on purpose, so `git add -A` can never commit them.

### 2. Authorise, once

```bash
npm run auth
```

Google warns that the app is unverified. Expected for an app with one user:
*Advanced > Go to ... (unsafe)*. The refresh token lands in
`~/.config/gdocs-mcp/token.json`, mode 0600.

Restart Claude Code, then confirm with `claude mcp list`.

### The 7-day re-auth, and why

While the consent screen sits in **Testing**, Google expires the refresh token
every 7 days. That is documented behaviour for external apps in testing, not a
bug, and there is no way around it for this scope set:
`auth/drive` is a **restricted** scope, and publishing to production with a
restricted scope requires a CASA security assessment — not worth it for a
one-person tool.

So roughly once a week a tool call will fail with "Authorisation expired". Fix:

```bash
npm run auth
```

Fifteen seconds. If you have a **Google Workspace** account, you can avoid it
entirely: create the Cloud project under that organisation and set the consent
screen user type to **Internal**. Internal apps have no 7-day expiry and no test
user list.

## Tools

| Tool | Effect |
|---|---|
| `find_doc` | Search Drive for Docs by title |
| `read_doc` | Body as Markdown + comment threads, each with its anchor text |
| `read_comments` | Comment threads only — the cheap "any new feedback?" check |
| `replace_text` | Exact find-and-replace in place; **keeps comment anchors** |
| `append_text` | Add a styled paragraph at the end (heading level, point size, colour, bold/italic); **appends only, keeps anchors** |
| `push_markdown` | Replace the whole body from a local file; requires `confirm: true` |
| `reply_comment` | Post a reply on a thread |
| `resolve_comment` | Resolve a thread with a closing note |
| `create_doc` | New Doc from a Markdown file — once per article |

All tools accept a Doc URL or a bare fileId.

## The comment-anchor tradeoff

Google anchors each comment to a span of text. Rewrite that span and the thread
detaches or auto-resolves. So:

- **Small fixes → `replace_text`.** Anchors survive; reviewers keep their context.
- **Structural rewrites → `push_markdown`.** Faster, but expect thread loss. It
  reports how many open threads existed beforehand, so the damage is visible
  rather than silent.
- **Adding rather than changing → `append_text`.** It only ever inserts at the
  end, so no existing span moves and no anchor breaks.
- **Reply before you rewrite.** `reply_comment` leaves a record of what changed
  and why.

## Why this and not an off-the-shelf server

An MCP server holding a Docs OAuth token can read and rewrite every document in
the account. There is no first-party Google or Anthropic Docs MCP; every published
one is a third-party package from an individual publisher. This is ~250 lines on
Anthropic's MCP SDK and Google's own client library — small enough to read before
you trust it.

## Read-only mode

```bash
claude mcp remove gdocs -s user
claude mcp add gdocs -s user -e GDOCS_MCP_READONLY=1 -- node "$PWD/server.mjs"
```

Reads keep working; every write tool refuses. Useful when someone else owns the Doc.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Not authorised yet" | Run `npm run auth` |
| `Error 403: access_denied`, "has not completed the Google verification process" | The signed-in address is not an approved tester. Add it under *OAuth consent screen > Audience > Test users*, save, retry |
| "Authorisation expired" after about a week | Expected in Testing mode. Run `npm run auth` |
| `accessNotConfigured` | Enable the Docs API and Drive API on **this** Cloud project |
| "no refresh token" | Revoke at <https://myaccount.google.com/permissions>, re-run `npm run auth` |
| Server missing in Claude Code | `claude mcp list`; re-run `./install.sh`; restart Claude Code |
| Doc exports as plain text | The Doc has content Google can't render as Markdown; content is still returned |

Verify the server independently at any time with `npm run smoke`.

To exercise a single tool without going through Claude Code:

```bash
node call.mjs read_comments '{"doc":"https://docs.google.com/document/d/FILEID/edit"}'
```

## Revoking access

<https://myaccount.google.com/permissions>, then delete `~/.config/gdocs-mcp/token.json`.

## Layout

```
server.mjs         the nine tools
google.mjs         auth + Drive/Docs clients; credential paths
auth.mjs           one-time interactive OAuth   (npm run auth)
smoke.mjs          starts the server, lists tools  (npm run smoke)
call.mjs           invoke one tool from the shell, for debugging
install.sh         deps, verify, register at user scope
docs/guide.html    the setup walkthrough as a standalone page
```

## License

MIT. See [LICENSE](LICENSE).
