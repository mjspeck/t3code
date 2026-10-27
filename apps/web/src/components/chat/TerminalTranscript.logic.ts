import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import {
  type TimelineEntry,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "../../session-logic";
import { v2EventPresentation } from "./TimelineV2EventRow.logic";

export type TerminalBlockStatus = "running" | "ok" | "failed" | "warning" | null;

export interface TerminalBlock {
  readonly id: string;
  readonly kind: "prompt" | "text" | "tool" | "note";
  readonly head: string;
  readonly body: string | null;
  readonly status: TerminalBlockStatus;
  /** The head and body are agent Markdown, so inline emphasis is styled. */
  readonly markdown: boolean;
}

export interface TerminalTextSegment {
  readonly text: string;
  readonly style: "plain" | "bold" | "italic" | "code";
}

// Code spans first so markers inside them stay literal. Underscore emphasis is
// skipped: it collides with snake_case identifiers far more often than it helps.
const INLINE_EMPHASIS = /`([^`\n]+)`|\*\*(?=\S)([^*\n]*?\S)\*\*|\*(?=[^\s*])([^*\n]*?[^\s*])\*/g;

export function terminalInlineSegments(text: string): ReadonlyArray<TerminalTextSegment> {
  const segments: TerminalTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_EMPHASIS)) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), style: "plain" });
    }
    const [, code, bold, italic] = match;
    segments.push(
      code !== undefined
        ? { text: code, style: "code" }
        : bold !== undefined
          ? { text: bold, style: "bold" }
          : { text: italic ?? "", style: "italic" },
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), style: "plain" });
  return segments;
}

const MAX_TOOL_BODY_LINES = 6;

function truncateLines(text: string, maxLines: number): string {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}\n… +${lines.length - maxLines} lines`;
}

function nonEmpty(text: string | null | undefined): string | null {
  return text && text.trim().length > 0 ? text : null;
}

function terminalBlockForEntry(entry: TimelineEntry): TerminalBlock | null {
  switch (entry.kind) {
    case "message": {
      const { message } = entry;
      if (message.role === "user") {
        const attachmentCount = message.attachments?.length ?? 0;
        const text = resolveUserMessagePresentation(message).text.trim();
        const attachments =
          attachmentCount === 0
            ? null
            : `[${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}]`;
        const head = text || attachments;
        if (head === null) return null;
        return {
          id: entry.id,
          kind: "prompt",
          head,
          body: text && attachments ? attachments : null,
          status: null,
          markdown: false,
        };
      }
      const text = nonEmpty(message.text);
      if (text === null) return null;
      return {
        id: entry.id,
        kind: message.role === "system" ? "note" : "text",
        head: text.trim(),
        body: null,
        status: null,
        markdown: message.role === "assistant",
      };
    }
    case "work": {
      const work = entry.entry;
      const head = work.command !== undefined ? `$ ${work.command}` : work.label;
      const detail =
        nonEmpty(work.detail) ??
        (work.changedFiles && work.changedFiles.length > 0 ? work.changedFiles.join("\n") : null);
      const status: TerminalBlockStatus =
        work.toolLifecycleStatus === "inProgress"
          ? "running"
          : workEntryIndicatesToolFailure(work)
            ? "failed"
            : workEntryIndicatesToolSuccess(work)
              ? "ok"
              : null;
      return {
        id: entry.id,
        kind: work.tone === "thinking" ? "note" : "tool",
        head,
        body: detail === null ? null : truncateLines(detail, MAX_TOOL_BODY_LINES),
        status,
        markdown: false,
      };
    }
    case "proposed-plan":
      return {
        id: entry.id,
        kind: "tool",
        head: "Plan",
        body: entry.proposedPlan.planMarkdown.trim(),
        status: null,
        markdown: true,
      };
    case "html-render":
      return {
        id: entry.id,
        kind: "tool",
        head: `Render ${entry.htmlRender.title}`,
        body: null,
        status: null,
        markdown: false,
      };
    case "mcp-app":
      return {
        id: entry.id,
        kind: "tool",
        head: `App ${entry.mcpApp.server}.${entry.mcpApp.tool}`,
        body: null,
        status: null,
        markdown: false,
      };
    case "event": {
      const presentation = v2EventPresentation(entry.projectedItem.item);
      return {
        id: entry.id,
        kind: "note",
        head: presentation.label,
        body: presentation.detail,
        status:
          presentation.tone === "danger"
            ? "failed"
            : presentation.tone === "warning"
              ? "warning"
              : presentation.tone === "success"
                ? "ok"
                : null,
        markdown: false,
      };
    }
  }
}

export function terminalBlocksForEntries(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TerminalBlock> {
  const blocks: TerminalBlock[] = [];
  for (const entry of entries) {
    const block = terminalBlockForEntry(entry);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}
