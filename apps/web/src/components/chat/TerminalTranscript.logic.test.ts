import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { terminalBlocksForEntries, terminalInlineSegments } from "./TerminalTranscript.logic";

const at = "2026-01-01T00:00:00Z";

function message(id: string, role: "user" | "assistant", text: string): TimelineEntry {
  return {
    kind: "message",
    id,
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
}

describe("terminalBlocksForEntries", () => {
  it("renders prompts, replies, and commands as transcript blocks", () => {
    const blocks = terminalBlocksForEntries([
      message("prompt", "user", "fix the failing test\n"),
      {
        kind: "work",
        id: "command",
        createdAt: at,
        entry: {
          id: "command",
          createdAt: at,
          label: "Ran command",
          tone: "tool",
          command: "vp test run foo.test.ts",
          detail: "1 failed, 12 passed",
          toolLifecycleStatus: "failed",
        },
      },
      message("reply", "assistant", "The test failed because…"),
    ]);

    expect(blocks).toEqual([
      {
        id: "prompt",
        kind: "prompt",
        head: "fix the failing test",
        body: null,
        status: null,
        markdown: false,
      },
      {
        id: "command",
        kind: "tool",
        head: "$ vp test run foo.test.ts",
        body: "1 failed, 12 passed",
        status: "failed",
        markdown: false,
      },
      {
        id: "reply",
        kind: "text",
        head: "The test failed because…",
        body: null,
        status: null,
        markdown: true,
      },
    ]);
  });

  it("drops empty replies and truncates long tool output", () => {
    const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const blocks = terminalBlocksForEntries([
      message("streaming", "assistant", "   "),
      {
        kind: "work",
        id: "read",
        createdAt: at,
        entry: {
          id: "read",
          createdAt: at,
          label: "Read file",
          tone: "tool",
          detail: output,
          toolLifecycleStatus: "inProgress",
        },
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ head: "Read file", status: "running" });
    expect(blocks[0]?.body?.split("\n")).toEqual([
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "… +4 lines",
    ]);
  });
});

describe("terminalInlineSegments", () => {
  it("styles bold, italic, and code without their markers", () => {
    expect(terminalInlineSegments("1. **Table:** use *one* `- [ ]` row")).toEqual([
      { text: "1. ", style: "plain" },
      { text: "Table:", style: "bold" },
      { text: " use ", style: "plain" },
      { text: "one", style: "italic" },
      { text: " ", style: "plain" },
      { text: "- [ ]", style: "code" },
      { text: " row", style: "plain" },
    ]);
  });

  it("leaves stray asterisks, snake_case, and markers inside code alone", () => {
    expect(terminalInlineSegments("a * b * c with snake_case_name")).toEqual([
      { text: "a * b * c with snake_case_name", style: "plain" },
    ]);
    expect(terminalInlineSegments("run `ls *.ts *.tsx`")).toEqual([
      { text: "run ", style: "plain" },
      { text: "ls *.ts *.tsx", style: "code" },
    ]);
  });
});
