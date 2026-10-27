import { describe, expect, it } from "vite-plus/test";

import { resolveThreadChatViewMode, toggleThreadChatViewModeOverride } from "./chatViewModeStore";

describe("chat view mode overrides", () => {
  it("follows the default until a thread is toggled", () => {
    expect(resolveThreadChatViewMode({}, "env:thread", "terminal")).toBe("terminal");
    expect(resolveThreadChatViewMode({}, null, "chat")).toBe("chat");
  });

  it("records only threads that differ from the default", () => {
    const toggled = toggleThreadChatViewModeOverride({}, "env:thread", "chat");
    expect(toggled).toEqual({ "env:thread": "terminal" });
    expect(toggleThreadChatViewModeOverride(toggled, "env:thread", "chat")).toEqual({});
  });

  it("keeps an override that a later default change made redundant until toggled away", () => {
    const overrides = { "env:thread": "terminal" } as const;
    expect(resolveThreadChatViewMode(overrides, "env:thread", "terminal")).toBe("terminal");
    expect(toggleThreadChatViewModeOverride(overrides, "env:thread", "terminal")).toEqual({
      "env:thread": "chat",
    });
  });
});
