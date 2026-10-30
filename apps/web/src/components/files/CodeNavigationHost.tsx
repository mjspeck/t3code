import type {
  CodeNavigationHover,
  CodeNavigationSymbol,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import { registerCommands } from "~/shortcuts/dispatcher";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { type CodeNavigationCommand, subscribeCodeNavigation } from "./codeNavigationStore";

const OCCURRENCE_ATTRIBUTE = "data-code-nav-occurrence";
const UI_ATTRIBUTE = "data-code-nav-ui";

interface SourcePoint {
  readonly line: number;
  readonly column: number;
  readonly x: number;
  readonly y: number;
}

interface HistoryPlace {
  readonly path: string;
  readonly line: number;
}

interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly path: string;
  readonly line: number;
}

type NavPanel =
  | {
      readonly kind: "list";
      readonly title: string;
      readonly items: readonly NavItem[];
      readonly empty: string;
    }
  | {
      readonly kind: "peek";
      readonly items: readonly NavItem[];
      readonly snippet: string;
      readonly detail: string;
    }
  | {
      readonly kind: "rename";
      readonly line: number;
      readonly column: number;
      readonly original: string;
    }
  | {
      readonly kind: "workspace";
      readonly query: string;
      readonly items: readonly NavItem[];
      readonly truncated: boolean;
    };

export function CodeNavigationHost(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly canRename: boolean;
  readonly children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const focused = useRef(true);
  const pointer = useRef<SourcePoint | null>(null);
  const hoverTimer = useRef(0);
  const commandClick = useRef<SourcePoint | null>(null);
  const workspaceTimer = useRef(0);
  const generation = useRef(0);
  const hoverGeneration = useRef(0);
  const history = useRef({
    back: [] as HistoryPlace[],
    forward: [] as HistoryPlace[],
  });
  const runRef = useRef<(command: CodeNavigationCommand, point?: SourcePoint) => void>(() => {});
  const panelRef = useRef<NavPanel | null>(null);
  const menuRef = useRef<{ readonly point: SourcePoint } | null>(null);
  const [panel, setPanel] = useState<NavPanel | null>(null);
  const [menu, setMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly point: SourcePoint;
  } | null>(null);
  const [hover, setHover] = useState<{
    readonly x: number;
    readonly y: number;
    readonly info: CodeNavigationHover;
    readonly trail: readonly string[];
  } | null>(null);
  const [draft, setDraft] = useState("");

  const query = useAtomCommand(projectEnvironment.codeNavigation, { reportFailure: false });
  const rename = useAtomCommand(projectEnvironment.codeRename, { reportFailure: false });

  const fail = (title: string) => {
    toastManager.add({ type: "error", title });
  };

  const openAt = (path: string, line: number) => {
    const here = { path: props.relativePath, line: pointer.current?.line ?? 1 };
    if (here.path !== path || here.line !== line) {
      history.current.back.push(here);
      history.current.forward = [];
    }
    setMenu(null);
    setHover(null);
    useRightPanelStore.getState().openFile(props.threadRef, path, line);
  };

  const paintLines = (lines: readonly number[]) => {
    const root = rootRef.current;
    if (!root) return;
    const wanted = new Set(lines);
    let attempts = 0;
    const apply = () => {
      const current = rootRef.current;
      if (!current) return true;
      const found = paintOccurrences(current, wanted);
      return found || attempts > 12;
    };
    if (apply()) return;
    const retry = () => {
      attempts += 1;
      if (!apply()) requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  };

  const ask = async (point: SourcePoint) => {
    const generationId = ++generation.current;
    const result = await query({
      environmentId: props.environmentId,
      input: {
        _tag: "atPosition",
        cwd: props.cwd,
        relativePath: props.relativePath,
        line: point.line,
        column: point.column,
      },
    });
    if (generationId !== generation.current) return null;
    if (result._tag !== "Success" || result.value._tag !== "atPosition") {
      fail("Couldn't look up that name.");
      return null;
    }
    return result.value;
  };

  const showSymbols = (title: string, items: readonly NavItem[], empty: string) => {
    if (items.length === 1) {
      const item = items[0];
      if (item) openAt(item.path, item.line);
      setPanel(null);
      return;
    }
    setPanel({ kind: "list", title, items, empty });
  };

  const run = (command: CodeNavigationCommand, explicitPoint?: SourcePoint) => {
    window.clearTimeout(hoverTimer.current);
    hoverGeneration.current += 1;
    setHover(null);
    const point = explicitPoint ?? currentPoint(rootRef.current, pointer.current);
    if (command === "back") {
      const previous = history.current.back.pop();
      if (!previous) return;
      history.current.forward.push({ path: props.relativePath, line: point?.line ?? 1 });
      setPanel(null);
      useRightPanelStore.getState().openFile(props.threadRef, previous.path, previous.line);
      return;
    }
    if (command === "forward") {
      const next = history.current.forward.pop();
      if (!next) return;
      history.current.back.push({ path: props.relativePath, line: point?.line ?? 1 });
      setPanel(null);
      useRightPanelStore.getState().openFile(props.threadRef, next.path, next.line);
      return;
    }
    if (command === "documentSymbols") {
      const generationId = ++generation.current;
      void query({
        environmentId: props.environmentId,
        input: { _tag: "documentSymbols", cwd: props.cwd, relativePath: props.relativePath },
      }).then((result) => {
        if (generationId !== generation.current) return;
        if (result._tag !== "Success" || result.value._tag !== "documentSymbols") {
          fail("Couldn't list symbols in this file.");
          return;
        }
        setMenu(null);
        setHover(null);
        setPanel({
          kind: "list",
          title: "Symbols in this file",
          items: result.value.symbols.map(symbolItem),
          empty: "No symbols in this file.",
        });
      });
      return;
    }
    if (command === "workspaceSymbols") {
      setMenu(null);
      setHover(null);
      setPanel({ kind: "workspace", query: "", items: [], truncated: false });
      return;
    }
    if (!point) {
      fail("Point at a name in the file first.");
      return;
    }
    if (command === "references") {
      const generationId = ++generation.current;
      void query({
        environmentId: props.environmentId,
        input: {
          _tag: "references",
          cwd: props.cwd,
          relativePath: props.relativePath,
          line: point.line,
          column: point.column,
        },
      }).then((result) => {
        if (generationId !== generation.current) return;
        if (result._tag !== "Success" || result.value._tag !== "references") {
          fail("Couldn't find references.");
          return;
        }
        setMenu(null);
        setHover(null);
        paintLines(
          result.value.references
            .filter((item) => item.path === props.relativePath)
            .map((item) => item.line),
        );
        setPanel({
          kind: "list",
          title: result.value.truncated ? "References (truncated)" : "References",
          items: result.value.references.map((item, index) => ({
            id: `${item.path}:${item.line}:${item.column}:${index}`,
            label: item.lineContent.trim() || item.path,
            detail: `${item.path}:${item.line}`,
            path: item.path,
            line: item.line,
          })),
          empty: "No references.",
        });
      });
      return;
    }
    if (command === "implementations") {
      const generationId = ++generation.current;
      void query({
        environmentId: props.environmentId,
        input: {
          _tag: "implementations",
          cwd: props.cwd,
          relativePath: props.relativePath,
          line: point.line,
          column: point.column,
        },
      }).then((result) => {
        if (generationId !== generation.current) return;
        if (result._tag !== "Success" || result.value._tag !== "implementations") {
          fail("Couldn't find implementations.");
          return;
        }
        setMenu(null);
        showSymbols(
          "Implementations",
          result.value.implementations.map(symbolItem),
          "No implementations.",
        );
      });
      return;
    }
    void (async () => {
      const lookedUp = await ask(point);
      if (!lookedUp) return;
      paintLines(lookedUp.highlights.map((span) => span.line));
      if (command === "rename") {
        if (!props.canRename) {
          fail("This file is read-only, so the symbol can't be renamed.");
          return;
        }
        const name = lookedUp.identifier ?? lookedUp.hover?.name ?? "";
        if (name.length === 0) {
          fail("Point at a name to rename.");
          return;
        }
        setDraft(name);
        setMenu(null);
        setHover(null);
        setPanel({ kind: "rename", line: point.line, column: point.column, original: name });
        return;
      }
      const symbols =
        command === "typeDefinition"
          ? lookedUp.typeDefinitions
          : command === "peek"
            ? lookedUp.definitions
            : lookedUp.definitions;
      if (symbols.length === 0) {
        fail(
          command === "typeDefinition"
            ? "No type definition for this name."
            : "No definition for this name.",
        );
        return;
      }
      if (command === "peek") {
        const first = symbols[0];
        setMenu(null);
        setHover(null);
        setPanel({
          kind: "peek",
          items: symbols.map(symbolItem),
          snippet: first?.snippet ?? first?.detail ?? "",
          detail: first ? `${first.path}:${first.line}` : "",
        });
        return;
      }
      setMenu(null);
      showSymbols(
        command === "typeDefinition" ? "Type definitions" : "Definitions",
        symbols.map(symbolItem),
        "No definition for this name.",
      );
    })();
  };

  // oxlint-disable-next-line t3code/react-effect-budget -- Shortcuts stay registered for the life of this file, so each render publishes the latest handler and panels to those refs.
  useEffect(() => {
    panelRef.current = panel;
    menuRef.current = menu;
    runRef.current = run;
  });

  const submitRename = () => {
    if (panel?.kind !== "rename") return;
    const nextName = draft.trim();
    if (nextName.length === 0 || nextName === panel.original) {
      setPanel(null);
      return;
    }
    const generationId = ++generation.current;
    void rename({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        relativePath: props.relativePath,
        line: panel.line,
        column: panel.column,
        newName: nextName,
      },
    }).then((result) => {
      if (generationId !== generation.current) return;
      if (result._tag !== "Success") {
        fail("Couldn't rename that symbol.");
        return;
      }
      setPanel(null);
      toastManager.add({
        type: "success",
        title: `Renamed ${result.value.occurrences} occurrence${result.value.occurrences === 1 ? "" : "s"}`,
        description: result.value.paths.length === 0 ? undefined : result.value.paths.join(", "),
      });
    });
  };

  const searchWorkspace = (value: string) => {
    setPanel((current) => (current?.kind === "workspace" ? { ...current, query: value } : current));
    window.clearTimeout(workspaceTimer.current);
    workspaceTimer.current = window.setTimeout(() => {
      const generationId = ++generation.current;
      void query({
        environmentId: props.environmentId,
        input: { _tag: "workspaceSymbols", cwd: props.cwd, query: value },
      }).then((result) => {
        if (generationId !== generation.current) return;
        if (result._tag !== "Success" || result.value._tag !== "workspaceSymbols") return;
        const symbols = result.value.symbols;
        const truncated = result.value.truncated;
        setPanel((current) =>
          current?.kind === "workspace"
            ? {
                ...current,
                query: value,
                items: symbols.map(symbolItem),
                truncated,
              }
            : current,
        );
      });
    }, 200);
  };

  // oxlint-disable-next-line t3code/react-effect-budget -- File-viewer shortcuts and focus live with this source surface and must detach when it unmounts.
  useEffect(() => {
    focused.current = true;
    const root = rootRef.current;
    const consume = (event: KeyboardEvent, command: CodeNavigationCommand) => {
      event.preventDefault();
      event.stopPropagation();
      runRef.current(command);
    };
    const onPointerDown = (event: PointerEvent) => {
      focused.current = root?.contains(event.target as Node) ?? false;
      if (!isUiTarget(event.target)) setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    const unsubscribe = subscribeCodeNavigation((command) => {
      runRef.current(command);
    });
    const unregister = registerCommands(
      {
        "code.goToDefinition": (event) => consume(event, "definition"),
        "code.peekDefinition": (event) => consume(event, "peek"),
        "code.goToTypeDefinition": (event) => consume(event, "typeDefinition"),
        "code.goToImplementation": (event) => consume(event, "implementations"),
        "code.findReferences": (event) => consume(event, "references"),
        "code.rename": (event) => consume(event, "rename"),
        "code.documentSymbols": (event) => consume(event, "documentSymbols"),
        "code.workspaceSymbols": (event) => consume(event, "workspaceSymbols"),
        "code.back": (event) => consume(event, "back"),
        "code.forward": (event) => consume(event, "forward"),
      },
      {
        capture: true,
        context: () => ({ fileFocus: focused.current }),
        onKeyDown: (event) => {
          if (event.key === "Escape" && (panelRef.current !== null || menuRef.current !== null)) {
            event.preventDefault();
            event.stopPropagation();
            setPanel(null);
            setMenu(null);
            setHover(null);
            return true;
          }
          if (!root?.contains(event.target as Node)) return false;
          const command = commandFromKey(event);
          if (!command) return false;
          consume(event, command);
          return true;
        },
      },
    );
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      unsubscribe();
      unregister();
      window.clearTimeout(hoverTimer.current);
      window.clearTimeout(workspaceTimer.current);
      focused.current = false;
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerMove={(event) => {
        if (isUiTarget(event.target)) return;
        const point = positionFromPoint(
          rootRef.current,
          event.clientX,
          event.clientY,
          event.nativeEvent.composedPath(),
        );
        pointer.current = point;
        event.currentTarget.style.cursor =
          point && (event.metaKey || event.ctrlKey) ? "pointer" : "";
        window.clearTimeout(hoverTimer.current);
        if (!point || panel || menu) {
          setHover(null);
          return;
        }
        const x = event.clientX;
        const y = event.clientY;
        hoverTimer.current = window.setTimeout(() => {
          const generationId = ++hoverGeneration.current;
          void query({
            environmentId: props.environmentId,
            input: {
              _tag: "atPosition",
              cwd: props.cwd,
              relativePath: props.relativePath,
              line: point.line,
              column: point.column,
            },
          }).then((result) => {
            if (generationId !== hoverGeneration.current) return;
            if (
              result._tag !== "Success" ||
              result.value._tag !== "atPosition" ||
              result.value.hover === null
            ) {
              setHover(null);
              return;
            }
            setHover({
              x,
              y,
              info: result.value.hover,
              trail: result.value.breadcrumbs.map((symbol) => symbol.name),
            });
          });
        }, 400);
      }}
      onPointerLeave={() => {
        commandClick.current = null;
        window.clearTimeout(hoverTimer.current);
        setHover(null);
      }}
      onPointerDownCapture={(event) => {
        if (event.button !== 0 || isUiTarget(event.target) || (!event.metaKey && !event.ctrlKey)) {
          return;
        }
        const point = positionFromPoint(
          rootRef.current,
          event.clientX,
          event.clientY,
          event.nativeEvent.composedPath(),
        );
        if (!point) return;
        commandClick.current = point;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerUpCapture={(event) => {
        const point = commandClick.current;
        commandClick.current = null;
        if (!point || (!event.metaKey && !event.ctrlKey)) return;
        event.preventDefault();
        event.stopPropagation();
        runRef.current("definition", point);
      }}
      onContextMenu={(event) => {
        if (isUiTarget(event.target)) return;
        const root = rootRef.current;
        if (!root || selectionInside(root)) return;
        const point = positionFromPoint(
          root,
          event.clientX,
          event.clientY,
          event.nativeEvent.composedPath(),
        );
        if (!point) return;
        event.preventDefault();
        setHover(null);
        setMenu({ x: event.clientX, y: event.clientY, point });
      }}
    >
      {props.children}
      {hover ? (
        <div
          className="pointer-events-none fixed z-40 max-w-md rounded-md border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-md"
          style={{ left: hover.x + 12, top: hover.y + 16 }}
          {...{ [UI_ATTRIBUTE]: "" }}
        >
          {hover.trail.length > 0 ? (
            <div className="mb-1 text-2xs text-muted-foreground">{hover.trail.join(" › ")}</div>
          ) : null}
          <div className="font-mono text-xs">{hover.info.detail}</div>
          {hover.info.documentation ? (
            <div className="mt-1 text-xs text-muted-foreground">{hover.info.documentation}</div>
          ) : null}
        </div>
      ) : null}
      {menu ? (
        <div
          className="fixed z-40 min-w-52 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
          style={{ left: menu.x, top: menu.y }}
          {...{ [UI_ATTRIBUTE]: "" }}
          role="menu"
        >
          <MenuButton
            label="Go to Definition"
            onPress={() => runRef.current("definition", menu.point)}
          />
          <MenuButton label="Peek Definition" onPress={() => runRef.current("peek", menu.point)} />
          <MenuButton
            label="Go to Type Definition"
            onPress={() => runRef.current("typeDefinition", menu.point)}
          />
          <MenuButton
            label="Go to Implementations"
            onPress={() => runRef.current("implementations", menu.point)}
          />
          <MenuButton
            label="Find All References"
            onPress={() => runRef.current("references", menu.point)}
          />
          {props.canRename ? (
            <MenuButton
              label="Rename Symbol"
              onPress={() => runRef.current("rename", menu.point)}
            />
          ) : null}
        </div>
      ) : null}
      {panel ? (
        <div
          className="absolute inset-x-2 bottom-2 z-20 max-h-72 overflow-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
          {...{ [UI_ATTRIBUTE]: "" }}
        >
          {panel.kind === "rename" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submitRename();
              }}
            >
              <div className="mb-2 text-xs text-muted-foreground">Rename symbol</div>
              <input
                className="w-full rounded-sm border border-border bg-background px-2 py-1 font-mono text-sm"
                value={draft}
                autoFocus
                aria-label="New name"
                onChange={(event) => setDraft(event.target.value)}
              />
            </form>
          ) : panel.kind === "workspace" ? (
            <div>
              <input
                className="mb-2 w-full rounded-sm border border-border bg-background px-2 py-1 text-sm"
                value={panel.query}
                autoFocus
                placeholder="Go to symbol in workspace"
                aria-label="Symbol query"
                onChange={(event) => searchWorkspace(event.target.value)}
              />
              <ItemList
                items={panel.items}
                empty={
                  panel.query.trim().length === 0 ? "Type a symbol name." : "No matching symbols."
                }
                onOpen={(item) => {
                  setPanel(null);
                  openAt(item.path, item.line);
                }}
              />
              {panel.truncated ? (
                <div className="px-2 pt-1 text-2xs text-muted-foreground">Results truncated.</div>
              ) : null}
            </div>
          ) : panel.kind === "peek" ? (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{panel.detail}</div>
              <pre className="mb-2 overflow-auto whitespace-pre-wrap font-mono text-xs">
                {panel.snippet}
              </pre>
              <ItemList
                items={panel.items}
                empty="No definition for this name."
                onOpen={(item) => {
                  setPanel(null);
                  openAt(item.path, item.line);
                }}
              />
            </div>
          ) : (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{panel.title}</div>
              <ItemList
                items={panel.items}
                empty={panel.empty}
                onOpen={(item) => {
                  setPanel(null);
                  openAt(item.path, item.line);
                }}
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MenuButton(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="block w-full rounded-sm px-2 py-1 text-left hover:bg-accent"
      onClick={props.onPress}
    >
      {props.label}
    </button>
  );
}

function ItemList(props: {
  readonly items: readonly NavItem[];
  readonly empty: string;
  readonly onOpen: (item: NavItem) => void;
}) {
  if (props.items.length === 0) {
    return <div className="px-2 py-1 text-sm text-muted-foreground">{props.empty}</div>;
  }
  return (
    <div role="listbox">
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="option"
          className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left hover:bg-accent"
          onClick={() => props.onOpen(item)}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.label}</span>
          <span className="shrink-0 text-2xs text-muted-foreground">{item.detail}</span>
        </button>
      ))}
    </div>
  );
}

function symbolItem(symbol: CodeNavigationSymbol, index: number): NavItem {
  return {
    id: `${symbol.path}:${symbol.line}:${symbol.column}:${index}`,
    label: symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name,
    detail: `${symbol.kind} ${symbol.path}:${symbol.line}`,
    path: symbol.path,
    line: symbol.line,
  };
}

function commandFromKey(event: KeyboardEvent): CodeNavigationCommand | null {
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  if (key === "f12" && mod && event.altKey) return "typeDefinition";
  if (key === "f12" && mod) return "implementations";
  if (key === "f12" && event.shiftKey) return "references";
  if (key === "f12" && event.altKey) return "peek";
  if (key === "f12") return "definition";
  if (key === "f2") return "rename";
  if (key === "o" && mod && event.altKey && event.shiftKey) return "workspaceSymbols";
  if (key === "o" && mod && event.altKey) return "documentSymbols";
  if (key === "arrowleft" && event.altKey && !mod && !event.shiftKey) return "back";
  if (key === "arrowright" && event.altKey && !mod && !event.shiftKey) return "forward";
  return null;
}

function currentPoint(root: HTMLElement | null, pointer: SourcePoint | null): SourcePoint | null {
  const selection = window.getSelection();
  if (root && selection && selection.rangeCount > 0) {
    const fromSelection = positionFromRange(root, selection.getRangeAt(0));
    if (fromSelection) return fromSelection;
  }
  return pointer;
}

function positionFromPoint(
  root: HTMLElement | null,
  x: number,
  y: number,
  path: readonly EventTarget[] = [],
): SourcePoint | null {
  if (!root) return null;
  const fromCaret = caretRangeFromPoint(x, y);
  const fromCaretPosition = fromCaret ? positionFromRange(root, fromCaret) : null;
  if (fromCaretPosition) return { ...fromCaretPosition, x, y };
  const hit = deepestElementAt(root, x, y);
  const lineElement = lineElementOnPath(root, path) ?? (hit ? lineElementFor(hit) : null);
  if (!lineElement || !nodeInside(root, lineElement)) return null;
  const line = Number(lineElement.getAttribute("data-line"));
  if (!Number.isInteger(line) || line < 1) return null;
  const text = lineElement.textContent ?? "";
  const column = columnAtClientX(lineElement, text, x);
  if (!/[A-Za-z0-9_$]/.test(text[column - 1] ?? "")) return null;
  return { line, column, x, y };
}

function lineElementOnPath(root: HTMLElement, path: readonly EventTarget[]): Element | null {
  for (const node of path) {
    if (!(node instanceof Element) || !nodeInside(root, node)) continue;
    const line = node.closest("[data-line]");
    if (line && nodeInside(root, line)) return line;
  }
  return null;
}

function deepestElementAt(root: HTMLElement, x: number, y: number): Element | null {
  let element = document.elementFromPoint(x, y);
  const seen = new Set<Element>();
  while (element) {
    if (!nodeInside(root, element)) return null;
    if (seen.has(element)) return element;
    seen.add(element);
    const inner = element.shadowRoot?.elementFromPoint(x, y) ?? null;
    if (!inner || inner === element) return element;
    element = inner;
  }
  return null;
}

function columnAtClientX(lineElement: Element, text: string, x: number): number {
  if (text.length === 0) return 1;
  if (caretLeft(lineElement, 0) === null) {
    const rect = lineElement.getBoundingClientRect();
    if (rect.width <= 0) return 1;
    const index = Math.floor(((x - rect.left) / rect.width) * text.length);
    return Math.min(text.length, Math.max(1, index + 1));
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const left = caretLeft(lineElement, mid);
    if (left === null || x < left) high = mid;
    else low = mid + 1;
  }
  return Math.min(text.length, Math.max(1, low));
}

function caretLeft(lineElement: Element, offset: number): number | null {
  const located = locateOffset(lineElement, offset);
  if (!located) return null;
  const range = document.createRange();
  range.setStart(located.node, located.offset);
  range.collapse(true);
  const rect = range.getClientRects()[0];
  return rect ? rect.left : null;
}

function locateOffset(lineElement: Element, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let current = walker.nextNode();
  while (current) {
    const length = current.textContent?.length ?? 0;
    if (remaining <= length && current instanceof Text) return { node: current, offset: remaining };
    remaining -= length;
    current = walker.nextNode();
  }
  return null;
}

function positionFromRange(root: HTMLElement, range: Range): SourcePoint | null {
  const node = range.startContainer;
  if (!nodeInside(root, node)) return null;
  const lineElement = lineElementFor(node);
  if (!lineElement) return null;
  const line = Number(lineElement.getAttribute("data-line"));
  if (!Number.isInteger(line) || line < 1) return null;
  const column = columnInLine(lineElement, node, range.startOffset);
  const text = lineElement.textContent ?? "";
  const character = text[column - 1] ?? "";
  if (!/[A-Za-z0-9_$]/.test(character)) return null;
  const rect = lineElement.getBoundingClientRect();
  return { line, column, x: rect.left, y: rect.bottom };
}

function caretRangeFromPoint(x: number, y: number): Range | null {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const position = document.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

function columnInLine(lineElement: Element, node: Node, offset: number): number {
  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT);
  let column = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return column + offset + 1;
    column += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return Math.max(1, column + 1);
}

function lineElementFor(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[data-line]") ?? null;
}

function nodeInside(root: HTMLElement, node: Node): boolean {
  if (root.contains(node)) return true;
  const owner = node.getRootNode();
  return owner instanceof ShadowRoot && root.contains(owner.host);
}

function selectionInside(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.toString().trim().length === 0) return false;
  return selection.anchorNode !== null && nodeInside(root, selection.anchorNode);
}

function isUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${UI_ATTRIBUTE}]`) !== null;
}

function paintOccurrences(root: HTMLElement, lines: ReadonlySet<number>): boolean {
  let found = false;
  const visit = (parent: ParentNode) => {
    for (const element of parent.querySelectorAll<HTMLElement>("[data-line]")) {
      found = true;
      const line = Number(element.getAttribute("data-line"));
      if (lines.has(line)) element.setAttribute(OCCURRENCE_ATTRIBUTE, "");
      else element.removeAttribute(OCCURRENCE_ATTRIBUTE);
    }
  };
  visit(root);
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.shadowRoot) visit(element.shadowRoot);
  }
  return found;
}
