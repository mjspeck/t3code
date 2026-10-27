import { LegendList } from "@legendapp/list/react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { TimelineEntry } from "../../session-logic";
import {
  type TerminalBlock,
  type TerminalBlockStatus,
  type TerminalTextSegment,
  terminalBlocksForEntries,
  terminalInlineSegments,
} from "./TerminalTranscript.logic";

const STATUS_CLASS: Record<Exclude<TerminalBlockStatus, null>, string> = {
  running: "text-muted-foreground",
  ok: "text-success",
  failed: "text-destructive",
  warning: "text-warning",
};

const SEGMENT_CLASS: Record<TerminalTextSegment["style"], string | undefined> = {
  plain: undefined,
  bold: "font-semibold",
  italic: "italic",
  code: "text-info",
};

function TerminalText({ text, markdown }: { text: string; markdown: boolean }) {
  if (!markdown) return text;
  let offset = 0;
  return terminalInlineSegments(text).map((segment) => {
    const start = offset;
    offset += segment.text.length;
    return segment.style === "plain" ? (
      segment.text
    ) : (
      <span key={start} className={SEGMENT_CLASS[segment.style]}>
        {segment.text}
      </span>
    );
  });
}

function blockMarker(block: TerminalBlock): string {
  switch (block.kind) {
    case "prompt":
      return ">";
    case "note":
      return "※";
    case "text":
    case "tool":
      return "⏺";
  }
}

function TerminalBlockRow({ block }: { block: TerminalBlock }) {
  return (
    <div
      className={cn(
        "chat-content-lane py-1.5 font-mono text-sm",
        block.kind === "prompt" && "mt-3 text-foreground",
        block.kind === "note" && "text-muted-foreground",
      )}
    >
      <div className="flex gap-2">
        <span
          aria-hidden
          className={cn(
            "shrink-0 select-none",
            block.kind === "prompt" && "text-muted-foreground",
            block.status !== null && STATUS_CLASS[block.status],
          )}
        >
          {blockMarker(block)}
        </span>
        <span
          className={cn(
            "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
            block.kind === "prompt" && "font-medium",
          )}
        >
          <TerminalText text={block.head} markdown={block.markdown} />
        </span>
      </div>
      {block.body === null ? null : (
        <div className="flex gap-2 ps-4 text-muted-foreground">
          <span aria-hidden className="shrink-0 select-none">
            ⎿
          </span>
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            <TerminalText text={block.body} markdown={block.markdown} />
          </span>
        </div>
      )}
    </div>
  );
}

function renderBlock({ item }: { item: TerminalBlock }) {
  return <TerminalBlockRow block={item} />;
}

function blockKey(block: TerminalBlock) {
  return block.id;
}

export const TerminalTranscript = memo(function TerminalTranscript({
  entries,
  isWorking,
  footer,
  bottomInset,
  topFadeEnabled,
}: {
  entries: ReadonlyArray<TimelineEntry>;
  isWorking: boolean;
  footer: ReactNode;
  /** Space the composer overlay covers at the bottom of the viewport. */
  bottomInset: number;
  topFadeEnabled: boolean;
}) {
  const blocks = terminalBlocksForEntries(entries);
  return (
    <LegendList<TerminalBlock>
      data={blocks}
      keyExtractor={blockKey}
      renderItem={renderBlock}
      estimatedItemSize={28}
      initialScrollAtEnd
      maintainScrollAtEnd
      maintainScrollAtEndThreshold={0.1}
      className={cn(
        "messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain pt-2",
        topFadeEnabled && "topbar-scroll-fade",
      )}
      ListFooterComponent={
        <>
          {isWorking ? (
            <div className="chat-content-lane py-1.5 font-mono text-sm text-muted-foreground">
              ✻ Working…
            </div>
          ) : null}
          {footer}
          <div aria-hidden style={{ height: bottomInset }} />
        </>
      }
    />
  );
});
