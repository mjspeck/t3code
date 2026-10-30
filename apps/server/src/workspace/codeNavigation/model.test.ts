import { describe, expect, it } from "vite-plus/test";

import {
  analyzePosition,
  applyRename,
  documentSymbolTree,
  implementationSymbols,
  indexNavigation,
  moduleCandidates,
  moduleSpecifiers,
  referenceSpans,
  topLevelNamed,
  workspaceSymbolMatches,
  type ModuleLink,
} from "./model.ts";

function index(files: Record<string, string>, links: readonly ModuleLink[] = []) {
  return indexNavigation(new Map(Object.entries(files)), links);
}

function columnOf(
  source: string,
  needle: string,
  occurrence = 0,
): { line: number; column: number } {
  const lines = source.split("\n");
  let seen = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const column = lines[lineIndex]!.indexOf(needle);
    if (column < 0) continue;
    if (seen === occurrence) return { line: lineIndex + 1, column: column + 1 };
    seen += 1;
  }
  throw new Error(`missing ${needle}`);
}

describe("code navigation model", () => {
  it("goes to a local function, its parameter, and this.method", () => {
    const source = [
      "export class Box {",
      "  value() {",
      "    return 1;",
      "  }",
      "  read() {",
      "    return this.value();",
      "  }",
      "}",
      "function format(count: number) {",
      "  return count;",
      "}",
    ].join("\n");
    const files = index({ "box.ts": source });
    const method = columnOf(source, "this.value");
    const atMethod = analyzePosition(files, "box.ts", method.line, method.column + "this.".length);
    expect(atMethod.definitions[0]).toMatchObject({ name: "value", kind: "method", line: 2 });

    const use = columnOf(source, "return count");
    const atParam = analyzePosition(files, "box.ts", use.line, use.column + "return ".length);
    expect(atParam.definitions[0]).toMatchObject({ name: "count", kind: "parameter", line: 9 });
    expect(atParam.hover?.detail).toContain("function format");
    expect(atParam.breadcrumbs.map((symbol) => symbol.name)).toEqual(["format"]);
  });

  it("follows imports and re-exports to the original declaration", () => {
    const origin = "export function widget() {\n  return 1;\n}\n";
    const bridge = 'export { widget } from "./origin";\n';
    const use = 'import { widget } from "./bridge";\n\nwidget();\n';
    const links: ModuleLink[] = [
      { from: "use.ts", specifier: "./bridge", path: "bridge.ts" },
      { from: "bridge.ts", specifier: "./origin", path: "origin.ts" },
    ];
    const files = index({ "origin.ts": origin, "bridge.ts": bridge, "use.ts": use }, links);
    const call = columnOf(use, "widget()");
    const atCall = analyzePosition(files, "use.ts", call.line, call.column);
    expect(atCall.definitions[0]).toMatchObject({ path: "origin.ts", name: "widget", line: 1 });
    expect(moduleSpecifiers("use.ts", use)).toEqual(["./bridge"]);
  });

  it("keeps a shadowed local out of the exported symbol's references", () => {
    const origin = "export function widget() {\n  return widget;\n}\n";
    const use = [
      'import { widget } from "./origin";',
      "widget();",
      "function inner() {",
      "  const widget = 1;",
      "  return widget;",
      "}",
    ].join("\n");
    const files = index({ "origin.ts": origin, "use.ts": use }, [
      { from: "use.ts", specifier: "./origin", path: "origin.ts" },
    ]);
    const definition = analyzePosition(files, "origin.ts", 1, columnOf(origin, "widget").column)
      .definitions[0]!;
    const references = referenceSpans(files, definition);
    const described = references.map(
      (item) => `${item.path}:${item.span.line}:${item.span.column}`,
    );
    expect(described).toContain("origin.ts:1:17");
    expect(described).toContain("origin.ts:2:10");
    expect(described).toContain("use.ts:1:10");
    expect(described).toContain("use.ts:2:1");
    expect(described.some((item) => item.startsWith("use.ts:4"))).toBe(false);
    expect(described.some((item) => item.startsWith("use.ts:5"))).toBe(false);
  });

  it("jumps to the annotated type", () => {
    const source = 'interface Id {\n  id: string;\n}\nconst current: Id = { id: "a" };\n';
    const files = index({ "id.ts": source });
    const at = columnOf(source, "current");
    const analysis = analyzePosition(files, "id.ts", at.line, at.column);
    expect(analysis.typeDefinitions[0]).toMatchObject({ name: "Id", kind: "interface" });
  });

  it("lists document symbols and workspace matches", () => {
    const source = "export class Panel {\n  title() {\n    return 1;\n  }\n}\n";
    const symbols = documentSymbolTree("panel.ts", source);
    expect(symbols.map((symbol) => symbol.name)).toEqual(["Panel", "title"]);
    expect(workspaceSymbolMatches("panel.ts", source, "pan").map((symbol) => symbol.name)).toEqual([
      "Panel",
    ]);
  });

  it("finds a class that implements an interface", () => {
    const face = "export interface Store {\n  read(): string;\n}\n";
    const body =
      'import type { Store } from "./store";\nexport class Memory implements Store {\n  read() { return ""; }\n}\n';
    const files = index({ "store.ts": face, "memory.ts": body }, [
      { from: "memory.ts", specifier: "./store", path: "store.ts" },
    ]);
    const target = analyzePosition(files, "store.ts", 1, columnOf(face, "Store").column)
      .definitions[0]!;
    expect(implementationSymbols(files, target).map((symbol) => symbol.name)).toEqual(["Memory"]);
  });

  it("resolves a python import to the function", () => {
    const origin = "def greet():\n    return 1\n";
    const use = "from greetings import greet\n\ngreet()\n";
    const files = index({ "greetings.py": origin, "main.py": use }, [
      { from: "main.py", specifier: "greetings", path: "greetings.py" },
    ]);
    const call = columnOf(use, "greet()");
    expect(analyzePosition(files, "main.py", call.line, call.column).definitions[0]).toMatchObject({
      path: "greetings.py",
      name: "greet",
    });
    expect(moduleCandidates("pkg/main.py", ".greetings")).toContain("pkg/greetings.py");
  });

  it("renames only the spans of the old name", () => {
    expect(
      applyRename(
        "const widget = widget;\n",
        [{ line: 1, column: 7, endColumn: 13 }],
        "widget",
        "panel",
      ),
    ).toBe("const panel = widget;\n");
    expect(
      applyRename("const other = 1;\n", [{ line: 1, column: 7, endColumn: 12 }], "widget", "panel"),
    ).toBeNull();
  });

  it("ignores names inside strings and comments", () => {
    const source = 'const label = "widget";\n// widget\nexport const widget = 1;\n';
    const files = index({ "names.ts": source });
    const inString = columnOf(source, "widget");
    expect(
      analyzePosition(files, "names.ts", inString.line, inString.column).identifier,
    ).toBeNull();
    const declaration = columnOf(source, "widget", 2);
    expect(
      analyzePosition(files, "names.ts", declaration.line, declaration.column).definitions[0]?.kind,
    ).toBe("constant");
  });

  it("finds an unambiguous top-level name", () => {
    const files = index({
      "a.ts": "export const portal = 1;\n",
      "b.ts": "const portal = 2;\n",
    });
    expect(topLevelNamed(files, "portal").map((symbol) => symbol.path)).toEqual(["a.ts"]);
  });
});
