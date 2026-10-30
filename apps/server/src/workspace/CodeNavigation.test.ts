import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CodeNavigation from "./CodeNavigation.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const layerKnownWorkspacesTest = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
  assertContains: () => Effect.void,
});

const layerEntries = Layer.mock(WorkspaceEntries.WorkspaceEntries)({
  browse: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
  search: () => Effect.die("unused"),
  listIgnoredFiles: () => Effect.die("unused"),
  refresh: () => Effect.void,
  searchContents: () => Effect.succeed({ matches: [], truncated: false }),
});

const layerTest = CodeNavigation.layer.pipe(
  Layer.provide(layerEntries),
  Layer.provide(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(layerKnownWorkspacesTest),
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(layerEntries),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(layerTest, { excludeTestServices: true })("CodeNavigation", (it) => {
  describe("query", () => {
    it.effect("jumps from an import to the declaration and renames both files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-code-nav-" });
        yield* writeTextFile(cwd, "origin.ts", "export function widget() {\n  return widget;\n}\n");
        yield* writeTextFile(cwd, "use.ts", 'import { widget } from "./origin";\n\nwidget();\n');
        const navigation = yield* CodeNavigation.CodeNavigation;

        const atCall = yield* navigation.query({
          _tag: "atPosition",
          cwd,
          relativePath: "use.ts",
          line: 3,
          column: 1,
        });
        expect(atCall._tag).toBe("atPosition");
        if (atCall._tag !== "atPosition") return;
        expect(atCall.definitions[0]).toMatchObject({ path: "origin.ts", name: "widget", line: 1 });
        expect(atCall.hover?.name).toBe("widget");

        const references = yield* navigation.query({
          _tag: "references",
          cwd,
          relativePath: "use.ts",
          line: 3,
          column: 1,
        });
        expect(references._tag).toBe("references");
        if (references._tag !== "references") return;
        expect(references.references).toHaveLength(4);
        expect([...new Set(references.references.map((item) => item.path))].toSorted()).toEqual([
          "origin.ts",
          "use.ts",
        ]);

        const renamed = yield* navigation.rename({
          cwd,
          relativePath: "use.ts",
          line: 3,
          column: 1,
          newName: "gadget",
        });
        const path = yield* Path.Path;
        expect(renamed.occurrences).toBeGreaterThan(1);
        expect(yield* fileSystem.readFileString(path.join(cwd, "origin.ts"))).toContain(
          "function gadget",
        );
        expect(yield* fileSystem.readFileString(path.join(cwd, "use.ts"))).toContain("gadget()");
      }),
    );

    it.effect("lists the symbols in one file", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-code-nav-" });
        yield* writeTextFile(
          cwd,
          "panel.ts",
          "export class Panel {\n  title() {\n    return 1;\n  }\n}\n",
        );
        const navigation = yield* CodeNavigation.CodeNavigation;
        const result = yield* navigation.query({
          _tag: "documentSymbols",
          cwd,
          relativePath: "panel.ts",
        });
        expect(result._tag).toBe("documentSymbols");
        if (result._tag !== "documentSymbols") return;
        expect(result.symbols.map((symbol) => symbol.name)).toEqual(["Panel", "title"]);
      }),
    );
  });
});
