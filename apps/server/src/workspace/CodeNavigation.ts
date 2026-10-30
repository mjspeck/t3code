import type {
  CodeNavigationHover,
  CodeNavigationReference,
  CodeNavigationRequest,
  CodeNavigationResult,
  CodeNavigationSymbol,
  CodeRenameRequest,
  CodeRenameResult,
  ProjectSearchContentsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import {
  analyzePosition,
  applyRename,
  documentSymbolTree,
  implementationSymbols,
  indexNavigation,
  isNavigablePath,
  isRenameName,
  languageOfPath,
  moduleCandidates,
  moduleSpecifiers,
  normalizeNavigationPath,
  parseJsonc,
  referenceSpans,
  topLevelNamed,
  workspaceSymbolMatches,
  type CodeSymbol,
  type ModuleLink,
  type NavigationIndex,
} from "./codeNavigation/model.ts";

const MAX_FILES = 40;
const MAX_REFERENCES = 200;
const MAX_SYMBOLS = 80;

export class CodeNavigationFailed extends Schema.TaggedError<CodeNavigationFailed>()(
  "CodeNavigationFailed",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

interface SourceGraph {
  readonly files: Map<string, string>;
  readonly links: ModuleLink[];
}

interface PathMapping {
  readonly base: string;
  readonly paths: readonly { readonly prefix: string; readonly targets: readonly string[] }[];
}

export class CodeNavigation extends Context.Service<
  CodeNavigation,
  {
    readonly query: (
      input: CodeNavigationRequest,
    ) => Effect.Effect<CodeNavigationResult, CodeNavigationFailed>;
    readonly rename: (
      input: CodeRenameRequest,
    ) => Effect.Effect<CodeRenameResult, CodeNavigationFailed>;
  }
>()("t3/workspace/CodeNavigation") {}

const make = Effect.gen(function* () {
  const filesystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const entries = yield* WorkspaceEntries.WorkspaceEntries;

  const readSource = Effect.fnUntraced(function* (cwd: string, relativePath: string) {
    const normalized = normalizeNavigationPath(relativePath);
    if (normalized.length === 0 || normalized.startsWith("..")) return null;
    const result = yield* filesystem
      .readFile({ cwd, relativePath: normalized, allowMissing: true })
      .pipe(Effect.orElseSucceed(() => null));
    if (result === null || result.exists === false) return null;
    return {
      path: normalizeNavigationPath(result.relativePath),
      text: result.contents,
    } satisfies SourceFile;
  });

  const search = Effect.fnUntraced(function* (
    cwd: string,
    query: string,
    useRegex: boolean,
  ): Effect.fn.Return<ProjectSearchContentsResult, never> {
    if (query.trim().length === 0) {
      return { matches: [], truncated: false };
    }
    return yield* entries
      .searchContents({
        cwd,
        query,
        limit: 200,
        caseSensitive: true,
        wholeWord: !useRegex,
        useRegex,
      })
      .pipe(Effect.orElseSucceed(() => ({ matches: [], truncated: false })));
  });

  const pathMappings = Effect.fnUntraced(function* (cwd: string, fromFile: string) {
    const mappings: PathMapping[] = [];
    const seen = new Set<string>();
    let directory = parentPath(fromFile);
    const candidates = ["tsconfig.json"];
    while (candidates.length < 8) {
      const next = directory.length === 0 ? "tsconfig.json" : `${directory}/tsconfig.json`;
      if (seen.has(next)) break;
      seen.add(next);
      candidates.push(next);
      if (directory.length === 0) break;
      directory = parentPath(directory);
    }
    for (const candidate of candidates) {
      const file = yield* readSource(cwd, candidate);
      if (!file) continue;
      const mapping = compilerPaths(file.path, file.text);
      if (mapping) mappings.push(mapping);
    }
    return mappings;
  });

  const resolveSpecifier = Effect.fnUntraced(function* (
    cwd: string,
    fromFile: string,
    specifier: string,
    mappings: readonly PathMapping[],
  ) {
    const candidates = [
      ...moduleCandidates(fromFile, specifier),
      ...mappingCandidates(specifier, mappings),
      ...packageCandidates(specifier),
    ].slice(0, 24);
    for (const candidate of candidates) {
      if (candidate.endsWith("/package.json") || candidate.endsWith("package.json")) {
        const manifest = yield* readSource(cwd, candidate);
        if (!manifest) continue;
        const entry = packageEntry(manifest.text);
        if (!entry) continue;
        const resolved = yield* readSource(cwd, joinRelative(parentPath(manifest.path), entry));
        if (resolved) return resolved.path;
        continue;
      }
      const file = yield* readSource(cwd, candidate);
      if (file && isNavigablePath(file.path)) return file.path;
    }
    return null;
  });

  const loadGraph = Effect.fnUntraced(function* (cwd: string, start: string) {
    const graph: SourceGraph = { files: new Map(), links: [] };
    const mappings = yield* pathMappings(cwd, start);
    const queue = [normalizeNavigationPath(start)];
    const seen = new Set<string>();
    while (queue.length > 0 && graph.files.size < MAX_FILES) {
      const current = queue.shift();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      const file = yield* readSource(cwd, current);
      if (!file) continue;
      graph.files.set(file.path, file.text);
      if (file.path.includes("/node_modules/")) continue;
      for (const specifier of moduleSpecifiers(file.path, file.text)) {
        const resolved = yield* resolveSpecifier(cwd, file.path, specifier, mappings);
        if (!resolved) continue;
        graph.links.push({ from: file.path, specifier, path: resolved });
        if (!seen.has(resolved)) queue.push(resolved);
      }
    }
    return graph;
  });

  const loadMatches = Effect.fnUntraced(function* (
    cwd: string,
    graph: SourceGraph,
    matches: ProjectSearchContentsResult["matches"],
  ) {
    for (const match of matches) {
      if (graph.files.size >= MAX_FILES) return;
      const path = normalizeNavigationPath(match.path);
      if (!isNavigablePath(path) || path.includes("/node_modules/") || graph.files.has(path))
        continue;
      const loaded = yield* loadGraph(cwd, path);
      for (const [filePath, text] of loaded.files) {
        if (graph.files.size >= MAX_FILES) return;
        if (!graph.files.has(filePath)) graph.files.set(filePath, text);
      }
      graph.links.push(...loaded.links);
    }
  });

  const indexed = (graph: SourceGraph): NavigationIndex =>
    indexNavigation(graph.files, graph.links);

  const symbolAt = Effect.fnUntraced(function* (
    cwd: string,
    relativePath: string,
    line: number,
    column: number,
  ) {
    const graph = yield* loadGraph(cwd, relativePath);
    const path = normalizeNavigationPath(relativePath);
    if (!graph.files.has(path)) {
      return yield* new CodeNavigationFailed({
        detail: "Can't read this file for code navigation.",
      });
    }
    let analysis = analyzePosition(indexed(graph), path, line, column);
    if (analysis.definitions.length === 0 && analysis.identifier) {
      const matches = yield* search(cwd, analysis.identifier, false);
      yield* loadMatches(cwd, graph, matches.matches);
      analysis = analyzePosition(indexed(graph), path, line, column);
      if (analysis.definitions.length === 0 && analysis.identifier) {
        analysis = {
          ...analysis,
          definitions: topLevelNamed(indexed(graph), analysis.identifier).slice(0, 20),
        };
      }
    }
    return { graph, path, analysis };
  });

  const query = Effect.fn("CodeNavigation.query")(function* (
    input: CodeNavigationRequest,
  ): Effect.fn.Return<CodeNavigationResult, CodeNavigationFailed> {
    switch (input._tag) {
      case "documentSymbols": {
        const file = yield* readSource(input.cwd, input.relativePath);
        if (!file) {
          return yield* new CodeNavigationFailed({
            detail: "Can't read this file for code navigation.",
          });
        }
        return {
          _tag: "documentSymbols",
          symbols: documentSymbolTree(file.path, file.text)
            .slice(0, 500)
            .map((symbol) => toSymbol(symbol, new Map([[file.path, file.text]]))),
        };
      }
      case "workspaceSymbols": {
        const queryText = input.query.trim();
        if (queryText.length === 0)
          return { _tag: "workspaceSymbols", symbols: [], truncated: false };
        const matches = yield* search(input.cwd, escapeRegExp(queryText), true);
        const symbols: CodeNavigationSymbol[] = [];
        const seen = new Set<string>();
        for (const match of matches.matches) {
          if (symbols.length >= MAX_SYMBOLS) break;
          const path = normalizeNavigationPath(match.path);
          if (seen.has(path) || !isNavigablePath(path)) continue;
          seen.add(path);
          const file = yield* readSource(input.cwd, path);
          if (!file) continue;
          for (const symbol of workspaceSymbolMatches(file.path, file.text, queryText)) {
            symbols.push(toSymbol(symbol, new Map([[file.path, file.text]])));
            if (symbols.length >= MAX_SYMBOLS) break;
          }
        }
        return {
          _tag: "workspaceSymbols",
          symbols,
          truncated: matches.truncated || symbols.length >= MAX_SYMBOLS,
        };
      }
      case "atPosition": {
        const located = yield* symbolAt(input.cwd, input.relativePath, input.line, input.column);
        const { analysis, graph } = located;
        return {
          _tag: "atPosition",
          identifier: analysis.identifier,
          definitions: analysis.definitions.map((symbol) => toSymbol(symbol, graph.files)),
          typeDefinitions: analysis.typeDefinitions.map((symbol) => toSymbol(symbol, graph.files)),
          hover: analysis.hover ? toHover(analysis.hover) : null,
          highlights: analysis.highlights,
          breadcrumbs: analysis.breadcrumbs
            .slice(-8)
            .map((symbol) => toSymbol(symbol, graph.files)),
        };
      }
      case "references":
      case "implementations": {
        const located = yield* symbolAt(input.cwd, input.relativePath, input.line, input.column);
        const target = located.analysis.definitions[0];
        if (!target) {
          return input._tag === "references"
            ? { _tag: "references", symbol: null, references: [], truncated: false }
            : { _tag: "implementations", symbol: null, implementations: [] };
        }
        if (target.exported || target.fileScoped) {
          const pattern =
            input._tag === "implementations"
              ? `(?:extends|implements)\\s+${escapeRegExp(target.name)}\\b`
              : target.name;
          const matches = yield* search(input.cwd, pattern, input._tag === "implementations");
          yield* loadMatches(input.cwd, located.graph, matches.matches);
        }
        const navigation = indexed(located.graph);
        if (input._tag === "implementations") {
          return {
            _tag: "implementations",
            symbol: toSymbol(target, located.graph.files),
            implementations: implementationSymbols(navigation, target)
              .slice(0, MAX_SYMBOLS)
              .map((symbol) => toSymbol(symbol, located.graph.files)),
          };
        }
        const spans = referenceSpans(navigation, target);
        return {
          _tag: "references",
          symbol: toSymbol(target, located.graph.files),
          references: spans
            .slice(0, MAX_REFERENCES)
            .map((item) =>
              toReference(item.path, item.span, located.graph.files.get(item.path) ?? ""),
            ),
          truncated: spans.length > MAX_REFERENCES,
        };
      }
    }
  });

  const rename = Effect.fn("CodeNavigation.rename")(function* (
    input: CodeRenameRequest,
  ): Effect.fn.Return<CodeRenameResult, CodeNavigationFailed> {
    const located = yield* symbolAt(input.cwd, input.relativePath, input.line, input.column);
    const target = located.analysis.definitions[0];
    if (!target) {
      return yield* new CodeNavigationFailed({
        detail: "There is no symbol at that position to rename.",
      });
    }
    if (!isRenameName(input.newName, languageOfPath(target.path))) {
      return yield* new CodeNavigationFailed({
        detail: "That is not a valid name in this language.",
      });
    }
    if (input.newName === target.name) return { paths: [], occurrences: 0 };
    if (target.exported || target.fileScoped) {
      const matches = yield* search(input.cwd, target.name, false);
      yield* loadMatches(input.cwd, located.graph, matches.matches);
    }
    const spans = referenceSpans(indexed(located.graph), target);
    if (spans.length > MAX_REFERENCES) {
      return yield* new CodeNavigationFailed({
        detail: "This symbol has too many references to rename at once.",
      });
    }
    if (spans.some((item) => item.path.includes("/node_modules/"))) {
      return yield* new CodeNavigationFailed({
        detail: "This symbol is in a dependency, so it can't be renamed here.",
      });
    }
    const byPath = new Map<string, Array<(typeof spans)[number]>>();
    for (const span of spans) {
      const group = byPath.get(span.path) ?? [];
      group.push(span);
      byPath.set(span.path, group);
    }
    const writes: Array<{ path: string; contents: string }> = [];
    for (const [path, group] of byPath) {
      const text = located.graph.files.get(path);
      if (!text) continue;
      const contents = applyRename(
        text,
        group.map((item) => item.span),
        target.name,
        input.newName,
      );
      if (contents === null) {
        return yield* new CodeNavigationFailed({
          detail: `Couldn't rename every occurrence in ${path}.`,
        });
      }
      writes.push({ path, contents });
    }
    for (const write of writes) {
      yield* filesystem
        .writeFile({ cwd: input.cwd, relativePath: write.path, contents: write.contents })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CodeNavigationFailed({
                detail: `Couldn't write ${write.path}.`,
                cause,
              }),
          ),
        );
    }
    return { paths: writes.map((write) => write.path), occurrences: spans.length };
  });

  return CodeNavigation.of({ query, rename });
});

export const layer = Layer.effect(CodeNavigation, make);

function toSymbol(symbol: CodeSymbol, files: ReadonlyMap<string, string>): CodeNavigationSymbol {
  const snippet = snippetAround(files.get(symbol.path), symbol.line);
  return {
    name: symbol.name,
    kind: symbol.kind,
    path: symbol.path,
    line: symbol.line,
    column: symbol.column,
    endColumn: Math.max(symbol.column + 1, symbol.endColumn),
    endLine: Math.max(symbol.line, symbol.endLine),
    ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
    detail: symbol.detail.trim().slice(0, 500) || symbol.name,
    ...(symbol.documentation ? { documentation: symbol.documentation.slice(0, 2_000) } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

function toHover(hover: {
  name: string;
  kind: CodeSymbol["kind"];
  detail: string;
  documentation?: string;
  path: string;
  line: number;
  column: number;
}): CodeNavigationHover {
  return {
    name: hover.name,
    kind: hover.kind,
    detail: hover.detail.trim().slice(0, 500) || hover.name,
    ...(hover.documentation ? { documentation: hover.documentation.slice(0, 2_000) } : {}),
    path: hover.path,
    line: hover.line,
    column: hover.column,
  };
}

function toReference(
  path: string,
  span: { line: number; column: number; endColumn: number },
  text: string,
): CodeNavigationReference {
  const line = text.split(/\r?\n/)[span.line - 1] ?? "";
  return {
    path,
    line: span.line,
    column: span.column,
    endColumn: Math.max(span.column + 1, span.endColumn),
    lineContent: line.trim().slice(0, 240) || " ",
  };
}

function snippetAround(text: string | undefined, line: number): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const snippet = lines
    .slice(Math.max(0, line - 1), line + 7)
    .join("\n")
    .slice(0, 500);
  return snippet.length > 0 ? snippet : undefined;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

function joinRelative(directory: string, relative: string): string {
  return normalizeNavigationPath(`${directory}/${relative}`);
}

function compilerPaths(path: string, text: string): PathMapping | null {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("compilerOptions" in parsed)) return null;
  const options = parsed.compilerOptions;
  if (typeof options !== "object" || options === null) return null;
  const baseUrl =
    "baseUrl" in options && typeof options.baseUrl === "string" ? options.baseUrl : ".";
  const rawPaths = "paths" in options ? options.paths : undefined;
  if (typeof rawPaths !== "object" || rawPaths === null) return null;
  const paths: Array<{ prefix: string; targets: string[] }> = [];
  for (const [prefix, targets] of Object.entries(rawPaths)) {
    if (!Array.isArray(targets)) continue;
    const strings = targets.filter((target): target is string => typeof target === "string");
    if (strings.length > 0) paths.push({ prefix, targets: strings });
  }
  if (paths.length === 0) return null;
  return { base: joinRelative(parentPath(path), baseUrl), paths };
}

function mappingCandidates(specifier: string, mappings: readonly PathMapping[]): readonly string[] {
  const candidates: string[] = [];
  for (const mapping of mappings) {
    for (const entry of mapping.paths) {
      const star = entry.prefix.endsWith("*") ? entry.prefix.slice(0, -1) : null;
      const matched =
        star === null
          ? specifier === entry.prefix
            ? ""
            : null
          : specifier.startsWith(star)
            ? specifier.slice(star.length)
            : null;
      if (matched === null) continue;
      for (const target of entry.targets) {
        const replaced = normalizeNavigationPath(
          `${mapping.base}/${target.replaceAll("*", matched)}`,
        );
        candidates.push(...moduleCandidates("index.ts", `./${replaced}`));
      }
    }
  }
  return candidates;
}

function packageCandidates(specifier: string): readonly string[] {
  if (specifier.startsWith(".") || specifier.length === 0) return [];
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name) return [];
  const sub = specifier.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
  const root = `node_modules/${name}`;
  return sub.length > 0 ? [`${root}/${sub}`, `${root}/package.json`] : [`${root}/package.json`];
}

function packageEntry(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { types?: unknown; typings?: unknown; main?: unknown };
    const entry = [parsed.types, parsed.typings, parsed.main].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return entry ?? null;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
