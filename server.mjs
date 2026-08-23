#!/usr/bin/env node
// Google Docs MCP server.
//
// Markdown in your repo stays the source of truth. The Doc is a review surface:
// we read it and its comment threads, and we push corrected Markdown back
// into the same file so the URL and the reviewers' tabs keep working.
//
// Set GDOCS_MCP_READONLY=1 to disable every write tool.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clients, toFileId, explain } from "./google.mjs";

const READONLY = process.env.GDOCS_MCP_READONLY === "1";

const server = new McpServer({ name: "gdocs", version: "1.0.0" });

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

/**
 * Every tool goes through here so a Google error arrives as an instruction
 * rather than a stack trace.
 */
function reg(name, meta, fn) {
  server.registerTool(name, meta, async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(explain(err));
    }
  });
}

const DOC_ARG = z
  .string()
  .describe("Google Doc URL or bare fileId. URLs are parsed automatically.");

// ---------------------------------------------------------------- read side

reg(
  "find_doc",
  {
    title: "Find a Google Doc",
    description:
      "Search Drive for Google Docs by title substring. Returns title, fileId, URL, and last-modified time.",
    inputSchema: {
      title_contains: z.string().describe("Substring of the document title."),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ title_contains, limit }) => {
    const { drive } = await clients();
    const escaped = title_contains.replace(/'/g, "\\'");
    const res = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.document' and trashed=false and name contains '${escaped}'`,
      fields: "files(id,name,modifiedTime,webViewLink)",
      orderBy: "modifiedTime desc",
      pageSize: limit,
    });
    const files = res.data.files ?? [];
    if (!files.length) return text(`No Google Docs matching "${title_contains}".`);
    return text(
      files
        .map(
          (f) =>
            `${f.name}\n  id:  ${f.id}\n  url: ${f.webViewLink}\n  modified: ${f.modifiedTime}`,
        )
        .join("\n\n"),
    );
  },
);

async function fetchComments(drive, fileId, includeResolved) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.comments.list({
      fileId,
      fields:
        "nextPageToken,comments(id,author(displayName),content,createdTime,resolved,quotedFileContent(value),replies(id,author(displayName),content,createdTime))",
      pageSize: 100,
      pageToken,
    });
    out.push(...(res.data.comments ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return includeResolved ? out : out.filter((c) => !c.resolved);
}

function renderComments(comments) {
  if (!comments.length) return "(no comment threads)";
  return comments
    .map((c, i) => {
      const quoted = c.quotedFileContent?.value?.replace(/\s+/g, " ").trim();
      const lines = [
        `### Thread ${i + 1}${c.resolved ? " [RESOLVED]" : ""}`,
        `id: ${c.id}`,
        quoted ? `anchored to: "${quoted}"` : "anchored to: (whole document)",
        `${c.author?.displayName ?? "unknown"} (${c.createdTime}): ${c.content}`,
      ];
      for (const r of c.replies ?? []) {
        lines.push(`  reply - ${r.author?.displayName ?? "unknown"}: ${r.content}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

async function exportMarkdown(drive, fileId) {
  try {
    const res = await drive.files.export(
      { fileId, mimeType: "text/markdown" },
      { responseType: "text" },
    );
    return res.data;
  } catch {
    const res = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    return res.data;
  }
}

reg(
  "read_doc",
  {
    title: "Read a Google Doc",
    description:
      "Export the document body as Markdown, optionally with its comment threads. Each thread reports the exact text it is anchored to, so feedback can be matched to the sentence it targets.",
    inputSchema: {
      doc: DOC_ARG,
      include_comments: z.boolean().default(true),
      include_resolved: z.boolean().default(false),
    },
  },
  async ({ doc, include_comments, include_resolved }) => {
    const fileId = toFileId(doc);
    const { drive } = await clients();
    const meta = await drive.files.get({ fileId, fields: "name,modifiedTime,webViewLink" });
    const body = await exportMarkdown(drive, fileId);
    let out = `# ${meta.data.name}\nurl: ${meta.data.webViewLink}\nmodified: ${meta.data.modifiedTime}\n\n---\n\n${body}`;
    if (include_comments) {
      const comments = await fetchComments(drive, fileId, include_resolved);
      out += `\n\n---\n\n## Comment threads (${comments.length})\n\n${renderComments(comments)}`;
    }
    return text(out);
  },
);

reg(
  "read_comments",
  {
    title: "Read comment threads only",
    description:
      "List the comment threads on a document without its body. Use this when checking for new review feedback.",
    inputSchema: { doc: DOC_ARG, include_resolved: z.boolean().default(false) },
  },
  async ({ doc, include_resolved }) => {
    const { drive } = await clients();
    const comments = await fetchComments(drive, toFileId(doc), include_resolved);
    return text(`## Comment threads (${comments.length})\n\n${renderComments(comments)}`);
  },
);

// --------------------------------------------------------------- write side

function guard() {
  if (READONLY) throw new Error("GDOCS_MCP_READONLY=1 is set; write tools are disabled.");
}

reg(
  "replace_text",
  {
    title: "Surgical find-and-replace",
    description:
      "Replace every occurrence of an exact string in the document. PREFER THIS over push_markdown for small fixes: it edits in place and leaves comment anchors attached.",
    inputSchema: {
      doc: DOC_ARG,
      find: z.string().min(1).describe("Exact text to find."),
      replace: z.string().describe("Replacement text. Empty string deletes."),
      match_case: z.boolean().default(true),
    },
  },
  async ({ doc, find, replace, match_case }) => {
    guard();
    const { docs } = await clients();
    const res = await docs.documents.batchUpdate({
      documentId: toFileId(doc),
      requestBody: {
        requests: [
          { replaceAllText: { containsText: { text: find, matchCase: match_case }, replaceText: replace } },
        ],
      },
    });
    const n = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
    return n === 0
      ? fail(`No occurrences of "${find}" found. Nothing changed.`)
      : text(`Replaced ${n} occurrence(s).`);
  },
);

reg(
  "push_markdown",
  {
    title: "Replace the whole document from Markdown",
    description:
      "Overwrite the entire document body with a local Markdown file, keeping the same fileId and URL. DESTRUCTIVE: Google detaches comment threads whose anchor text is rewritten. Requires confirm=true.",
    inputSchema: {
      doc: DOC_ARG,
      file_path: z.string().describe("Absolute path to the Markdown file to upload."),
      confirm: z
        .boolean()
        .default(false)
        .describe("Must be true. Guard against overwriting a doc unintentionally."),
    },
  },
  async ({ doc, file_path, confirm }) => {
    guard();
    if (!confirm)
      return fail(
        "Refused: confirm=true is required. This replaces the entire document body and may detach existing comment threads.",
      );
    const body = await readFile(file_path, "utf8");
    const fileId = toFileId(doc);
    const { drive } = await clients();
    const before = await fetchComments(drive, fileId, false);
    const res = await drive.files.update({
      fileId,
      media: { mimeType: "text/markdown", body },
      fields: "id,name,modifiedTime,webViewLink",
    });
    return text(
      `Pushed ${body.length} chars to "${res.data.name}".\n` +
        `url: ${res.data.webViewLink}\nmodified: ${res.data.modifiedTime}\n` +
        `${before.length} open comment thread(s) existed before this push; re-run read_comments to see which survived.`,
    );
  },
);

const HEADINGS = {
  TITLE: "TITLE",
  H1: "HEADING_1",
  H2: "HEADING_2",
  H3: "HEADING_3",
  H4: "HEADING_4",
  H5: "HEADING_5",
  H6: "HEADING_6",
  NORMAL: "NORMAL_TEXT",
};

const NAMED_COLORS = {
  red: "#FF0000", green: "#008000", blue: "#0000FF", black: "#000000",
  white: "#FFFFFF", grey: "#808080", gray: "#808080", orange: "#FF6D00",
  purple: "#9900FF", yellow: "#FFD600",
};

/** "#FF0000" or "red" -> Docs API rgbColor (0..1 floats). */
function toRgb(input) {
  const named = NAMED_COLORS[String(input).toLowerCase()];
  const hex = String(named ?? input).replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex))
    throw new Error(`Unrecognised color "${input}". Use a hex value like #FF0000 or a name like red.`);
  return {
    red: parseInt(hex.slice(0, 2), 16) / 255,
    green: parseInt(hex.slice(2, 4), 16) / 255,
    blue: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

reg(
  "append_text",
  {
    title: "Append a styled paragraph",
    description:
      "Add a paragraph at the end of the document, optionally as a heading and with an explicit size, color, or weight. Appends only: existing text is untouched, so every comment anchor survives. Use this instead of push_markdown when you just need to add something.",
    inputSchema: {
      doc: DOC_ARG,
      text: z.string().min(1).describe("The paragraph text. No trailing newline needed."),
      heading: z
        .enum(["TITLE", "H1", "H2", "H3", "H4", "H5", "H6", "NORMAL"])
        .default("NORMAL")
        .describe("Paragraph style. Applied before character styling so it cannot override it."),
      font_size_pt: z.number().min(1).max(400).optional().describe("Point size, e.g. 19."),
      color: z.string().optional().describe('Hex like "#FF0000" or a name like "red".'),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
    },
  },
  async ({ doc, text: body, heading, font_size_pt, color, bold, italic }) => {
    guard();
    const documentId = toFileId(doc);
    const { docs } = await clients();

    const snapshot = await docs.documents.get({
      documentId,
      fields: "body(content(endIndex))",
    });
    const content = snapshot.data.body?.content ?? [];
    if (!content.length) throw new Error("Document body is empty; nothing to append to.");

    // The final newline of the body cannot be deleted or written past,
    // so insertion goes immediately before it.
    const insertAt = content[content.length - 1].endIndex - 1;

    // A leading newline starts a new paragraph, so the appended text does not
    // inherit the style of whatever the document currently ends with.
    const start = insertAt + 1;
    const end = start + body.length;
    const range = { startIndex: start, endIndex: end };

    const requests = [
      { insertText: { location: { index: insertAt }, text: `\n${body}` } },
      {
        updateParagraphStyle: {
          range,
          paragraphStyle: { namedStyleType: HEADINGS[heading] },
          fields: "namedStyleType",
        },
      },
    ];

    // Character styling must come after the named style, which resets it.
    const textStyle = {};
    const fields = [];
    if (font_size_pt !== undefined) {
      textStyle.fontSize = { magnitude: font_size_pt, unit: "PT" };
      fields.push("fontSize");
    }
    if (color !== undefined) {
      textStyle.foregroundColor = { color: { rgbColor: toRgb(color) } };
      fields.push("foregroundColor");
    }
    if (bold !== undefined) { textStyle.bold = bold; fields.push("bold"); }
    if (italic !== undefined) { textStyle.italic = italic; fields.push("italic"); }
    if (fields.length) {
      requests.push({ updateTextStyle: { range, textStyle, fields: fields.join(",") } });
    }

    await docs.documents.batchUpdate({ documentId, requestBody: { requests } });

    const applied = [
      heading === "NORMAL" ? "normal text" : heading,
      font_size_pt !== undefined ? `${font_size_pt}pt` : null,
      color !== undefined ? String(color) : null,
      bold ? "bold" : null,
      italic ? "italic" : null,
    ].filter(Boolean);

    return text(
      `Appended to the end of the document as ${applied.join(", ")}:\n\n  ${body}\n\n` +
        `Existing text was not modified, so all comment anchors are intact.`,
    );
  },
);

reg(
  "reply_comment",
  {
    title: "Reply to a comment thread",
    description:
      "Post a reply on a comment thread. Use this to tell a reviewer what you changed instead of silently rewriting under their comment.",
    inputSchema: {
      doc: DOC_ARG,
      comment_id: z.string().describe("Thread id from read_comments."),
      text: z.string().min(1),
    },
  },
  async ({ doc, comment_id, text: body }) => {
    guard();
    const { drive } = await clients();
    await drive.replies.create({
      fileId: toFileId(doc),
      commentId: comment_id,
      fields: "id",
      requestBody: { content: body },
    });
    return text(`Replied to thread ${comment_id}.`);
  },
);

reg(
  "resolve_comment",
  {
    title: "Resolve a comment thread",
    description: "Mark a comment thread resolved, with an optional closing note.",
    inputSchema: {
      doc: DOC_ARG,
      comment_id: z.string(),
      note: z.string().default("Addressed."),
    },
  },
  async ({ doc, comment_id, note }) => {
    guard();
    const { drive } = await clients();
    await drive.replies.create({
      fileId: toFileId(doc),
      commentId: comment_id,
      fields: "id",
      requestBody: { content: note, action: "resolve" },
    });
    return text(`Resolved thread ${comment_id}.`);
  },
);

reg(
  "create_doc",
  {
    title: "Create a Google Doc from Markdown",
    description:
      "Create a new Google Doc from a local Markdown file. Returns the new URL. Use once per article, then push_markdown for every later round.",
    inputSchema: {
      title: z.string().min(1),
      file_path: z.string().describe("Absolute path to the Markdown file."),
      folder_id: z.string().optional().describe("Destination Drive folder id."),
    },
  },
  async ({ title, file_path, folder_id }) => {
    guard();
    const body = await readFile(file_path, "utf8");
    const { drive } = await clients();
    const res = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.document",
        ...(folder_id ? { parents: [folder_id] } : {}),
      },
      media: { mimeType: "text/markdown", body },
      fields: "id,name,webViewLink",
    });
    return text(`Created "${res.data.name}"\nid:  ${res.data.id}\nurl: ${res.data.webViewLink}`);
  },
);

await server.connect(new StdioServerTransport());
