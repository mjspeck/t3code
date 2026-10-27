import type { ChatViewMode } from "@t3tools/contracts/settings";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface ChatViewModeStoreState {
  /** Only threads that differ from the default; the default setting governs the rest. */
  overrideByThreadKey: Record<string, ChatViewMode>;
  toggleThread: (threadKey: string, defaultMode: ChatViewMode) => void;
}

export function resolveThreadChatViewMode(
  overrideByThreadKey: Record<string, ChatViewMode>,
  threadKey: string | null,
  defaultMode: ChatViewMode,
): ChatViewMode {
  return (threadKey === null ? undefined : overrideByThreadKey[threadKey]) ?? defaultMode;
}

export function toggleThreadChatViewModeOverride(
  overrideByThreadKey: Record<string, ChatViewMode>,
  threadKey: string,
  defaultMode: ChatViewMode,
): Record<string, ChatViewMode> {
  const current = resolveThreadChatViewMode(overrideByThreadKey, threadKey, defaultMode);
  const next: ChatViewMode = current === "chat" ? "terminal" : "chat";
  const { [threadKey]: _previous, ...rest } = overrideByThreadKey;
  return next === defaultMode ? rest : { ...rest, [threadKey]: next };
}

export const useChatViewModeStore = create<ChatViewModeStoreState>()(
  persist(
    (set) => ({
      overrideByThreadKey: {},
      toggleThread: (threadKey, defaultMode) =>
        set((state) => ({
          overrideByThreadKey: toggleThreadChatViewModeOverride(
            state.overrideByThreadKey,
            threadKey,
            defaultMode,
          ),
        })),
    }),
    {
      name: "t3code:chat-view-mode:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ overrideByThreadKey: state.overrideByThreadKey }),
    },
  ),
);

export function useThreadChatViewMode(
  threadKey: string | null,
  defaultMode: ChatViewMode,
): ChatViewMode {
  return useChatViewModeStore((state) =>
    resolveThreadChatViewMode(state.overrideByThreadKey, threadKey, defaultMode),
  );
}
