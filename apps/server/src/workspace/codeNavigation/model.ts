export const CODE_SYMBOL_KINDS = [
  "class",
  "constant",
  "enum",
  "field",
  "function",
  "interface",
  "method",
  "module",
  "namespace",
  "parameter",
  "property",
  "struct",
  "trait",
  "type",
  "variable",
] as const;

export type CodeSymbolKind = (typeof CODE_SYMBOL_KINDS)[number];

export type CodeLanguage = "javascript" | "python" | "go" | "rust" | "c" | "generic";

export interface CodeSpan {
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
}

export interface CodeSymbol {
  readonly name: string;
  readonly kind: CodeSymbolKind;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly scopeStartLine: number;
  readonly scopeEndLine: number;
  readonly containerName?: string;
  readonly detail: string;
  readonly documentation?: string;
  readonly exported: boolean;
  readonly isDefaultExport: boolean;
  readonly member: boolean;
  readonly typeName?: string;
  readonly bases: readonly string[];
  readonly fileScoped: boolean;
}

export interface ImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly specifier: string;
  readonly localSpan: CodeSpan;
  readonly importedSpan: CodeSpan;
  readonly kind: "value" | "type" | "namespace";
}

export interface ReexportBinding {
  readonly exported: string;
  readonly imported: string;
  readonly specifier: string | null;
  readonly span: CodeSpan;
  readonly importedSpan: CodeSpan;
}

export interface ParsedFile {
  readonly path: string;
  readonly symbols: readonly CodeSymbol[];
  readonly imports: readonly ImportBinding[];
  readonly reexports: readonly ReexportBinding[];
  readonly starExports: readonly string[];
}

export interface ModuleLink {
  readonly from: string;
  readonly specifier: string;
  readonly path: string;
}

export interface NavigationIndex {
  readonly files: ReadonlyMap<string, ParsedFile>;
  readonly links: ReadonlyMap<string, string>;
}

export interface IdentifierAt {
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  readonly qualifier?: {
    readonly name: string;
    readonly line: number;
    readonly column: number;
  };
}

export interface HoverInfo {
  readonly name: string;
  readonly kind: CodeSymbolKind;
  readonly detail: string;
  readonly documentation?: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface PositionAnalysis {
  readonly identifier: string | null;
  readonly definitions: readonly CodeSymbol[];
  readonly typeDefinitions: readonly CodeSymbol[];
  readonly hover: HoverInfo | null;
  readonly highlights: readonly CodeSpan[];
  readonly breadcrumbs: readonly CodeSymbol[];
}

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
const PY_EXTS = [".py", ".pyi"];

const JS_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "keyof",
  "let",
  "new",
  "null",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

const BREADCRUMB_KINDS = new Set<CodeSymbolKind>([
  "class",
  "enum",
  "function",
  "interface",
  "method",
  "module",
  "namespace",
  "struct",
  "trait",
]);

export function languageOfPath(path: string): CodeLanguage {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".vue":
    case ".svelte":
      return "javascript";
    case ".py":
    case ".pyi":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".c":
    case ".h":
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp":
    case ".hh":
    case ".cs":
    case ".java":
    case ".kt":
    case ".kts":
    case ".scala":
    case ".swift":
      return "c";
    default:
      return "generic";
  }
}

export function isNavigablePath(path: string): boolean {
  return (
    languageOfPath(path) !== "generic" || /\.(rb|php|ex|exs|lua|zig|sh|bash|zsh|scala)$/i.test(path)
  );
}

export function moduleSpecifiers(path: string, text: string): readonly string[] {
  const parsed = parseFile(path, text);
  return [
    ...new Set([
      ...parsed.imports.map((item) => item.specifier),
      ...parsed.reexports.flatMap((item) => (item.specifier ? [item.specifier] : [])),
      ...parsed.starExports,
    ]),
  ];
}

export function moduleCandidates(fromPath: string, specifier: string): readonly string[] {
  const language = languageOfPath(fromPath);
  if (language === "python") return pythonCandidates(fromPath, specifier);
  if (language === "rust") return rustCandidates(fromPath, specifier);
  if (!specifier.startsWith(".")) return [];
  return extensionCandidates(joinPath(dirname(fromPath), specifier), language);
}

export function indexNavigation(
  files: ReadonlyMap<string, string>,
  links: readonly ModuleLink[],
): NavigationIndex {
  const parsed = new Map<string, ParsedFile>();
  for (const [path, text] of files)
    parsed.set(normalizeNavigationPath(path), parseFile(normalizeNavigationPath(path), text));
  const resolved = new Map<string, string>();
  for (const link of links) {
    resolved.set(
      linkKey(normalizeNavigationPath(link.from), link.specifier),
      normalizeNavigationPath(link.path),
    );
  }
  return { files: parsed, links: resolved };
}

export function analyzePosition(
  index: NavigationIndex,
  path: string,
  line: number,
  column: number,
): PositionAnalysis {
  const file = index.files.get(normalizeNavigationPath(path));
  if (!file) {
    return {
      identifier: null,
      definitions: [],
      typeDefinitions: [],
      hover: null,
      highlights: [],
      breadcrumbs: [],
    };
  }
  const text = sourceText(index, file.path);
  const ident = text ? identifierAt(text, file.path, line, column) : null;
  const definitions = ident ? resolveIdentifier(index, file, ident, line, column) : [];
  const primary = definitions[0];
  const typeDefinitions = primary ? resolveTypeDefinitions(index, primary) : [];
  const breadcrumbs = file.symbols
    .filter(
      (symbol) =>
        BREADCRUMB_KINDS.has(symbol.kind) && symbol.line <= line && symbol.endLine >= line,
    )
    .toSorted((left, right) => left.line - right.line || right.endLine - left.endLine);
  return {
    identifier: ident?.name ?? null,
    definitions,
    typeDefinitions,
    hover: primary ? hoverFor(primary) : null,
    highlights: primary ? highlightsInFile(index, file, primary) : [],
    breadcrumbs,
  };
}

export function documentSymbolTree(path: string, text: string): readonly CodeSymbol[] {
  return parseFile(path, text).symbols.filter((symbol) => symbol.kind !== "parameter");
}

export function referenceSpans(
  index: NavigationIndex,
  target: CodeSymbol,
): readonly { path: string; span: CodeSpan }[] {
  const found: { path: string; span: CodeSpan }[] = [];
  for (const file of index.files.values()) {
    const text = sourceText(index, file.path);
    if (!text) continue;
    for (const ident of identifiersIn(text, file.path)) {
      const resolved = resolveIdentifier(index, file, ident, ident.line, ident.column);
      if (resolved.some((symbol) => sameSymbol(symbol, target))) {
        found.push({
          path: file.path,
          span: {
            line: ident.line,
            column: ident.column,
            endColumn: ident.endColumn,
          },
        });
      }
    }
  }
  return found;
}

export function implementationSymbols(
  index: NavigationIndex,
  target: CodeSymbol,
): readonly CodeSymbol[] {
  const found: CodeSymbol[] = [];
  for (const file of index.files.values()) {
    for (const symbol of file.symbols) {
      if (symbol.kind !== "class" && symbol.kind !== "struct" && symbol.kind !== "interface")
        continue;
      if (sameSymbol(symbol, target)) continue;
      const matches = symbol.bases.some((base) => {
        const resolved = resolveName(index, file, base, symbol.line);
        return resolved.some((item) => sameSymbol(item, target));
      });
      if (matches) found.push(symbol);
    }
  }
  return found;
}

export function workspaceSymbolMatches(
  path: string,
  text: string,
  query: string,
): readonly CodeSymbol[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return parseFile(path, text).symbols.filter(
    (symbol) =>
      symbol.kind !== "parameter" && !symbol.member && symbol.name.toLowerCase().includes(needle),
  );
}

export function applyRename(
  text: string,
  spans: readonly CodeSpan[],
  oldName: string,
  newName: string,
): string | null {
  const ordered = [...spans].toSorted(
    (left, right) => right.line - left.line || right.column - left.column,
  );
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const trailing = text.endsWith(newline);
  const body = trailing ? text.slice(0, -newline.length) : text;
  const lines = body.split(/\r?\n/);
  for (const span of ordered) {
    const line = lines[span.line - 1];
    if (!line) return null;
    const current = line.slice(span.column - 1, span.endColumn - 1);
    if (current !== oldName) return null;
    lines[span.line - 1] =
      line.slice(0, span.column - 1) + newName + line.slice(span.endColumn - 1);
  }
  return lines.join(newline) + (trailing ? newline : "");
}

export function isRenameName(name: string, language: CodeLanguage): boolean {
  if (language === "javascript") return /^[A-Za-z_$][\w$]*$/.test(name) && !JS_KEYWORDS.has(name);
  return /^[A-Za-z_][\w]*$/.test(name);
}

export function parseJsonc(text: string): unknown {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      out += text.slice(start, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index = Math.min(text.length, index + 2);
      out += " ";
      continue;
    }
    out += char;
    index += 1;
  }
  return JSON.parse(out);
}

function sourceText(index: NavigationIndex, path: string): string | null {
  const file = index.files.get(path);
  if (!file) return null;
  return fileTextByPath.get(file) ?? null;
}

const fileTextByPath = new WeakMap<ParsedFile, string>();

function parseFile(path: string, text: string): ParsedFile {
  const language = languageOfPath(path);
  const parsed =
    language === "javascript"
      ? parseJavaScript(path, text)
      : language === "python"
        ? parsePython(path, text)
        : parseBraceLanguage(path, text, language);
  fileTextByPath.set(parsed, text);
  return parsed;
}

function parseJavaScript(path: string, text: string): ParsedFile {
  const masked = maskSource(text, "javascript");
  const lines = splitLines(text);
  const maskedLines = splitLines(masked);
  const symbols: MutableSymbol[] = [];
  const imports: ImportBinding[] = [];
  const reexports: ReexportBinding[] = [];
  const starExports: string[] = [];
  const blocks: Array<{
    kind: "class" | "function" | "other";
    bodyDepth: number;
    symbolIndex: number | null;
    name: string;
  }> = [];
  let depth = 0;
  let pending: { kind: "class" | "function"; symbolIndex: number; name: string } | null = null;

  const finishDepth = (lineNumber: number) => {
    while (blocks.length > 0 && blocks[blocks.length - 1]!.bodyDepth > depth) {
      const block = blocks.pop()!;
      if (block.symbolIndex !== null) {
        const symbol = symbols[block.symbolIndex];
        if (symbol) symbol.endLine = lineNumber;
      }
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const raw = lines[lineIndex] ?? "";
    const code = (maskedLines[lineIndex] ?? "").trim();
    const classBlock = [...blocks].reverse().find((block) => block.kind === "class");
    const inClassBody = classBlock !== undefined && depth === classBlock.bodyDepth;
    const functionBlock = [...blocks].reverse().find((block) => block.kind === "function");
    const scopeOwner = functionBlock?.symbolIndex ?? null;

    if (depth === 0 && (/^import\b/.test(code) || /^export\s+(?:type\s+)?(?:\*|\{)/.test(code))) {
      const statement = collectStatement(maskedLines, lines, lineIndex);
      const parsed = parseJavaScriptModuleStatement(path, statement.text, lineNumber);
      imports.push(...parsed.imports);
      reexports.push(...parsed.reexports);
      starExports.push(...parsed.starExports);
      if (statement.endLine > lineNumber) {
        lineIndex = statement.endLine - 1;
        continue;
      }
    }

    const declared = matchJavaScriptDeclaration(code);
    if (
      declared &&
      (depth === 0 || functionBlock !== undefined || (inClassBody && declared.member))
    ) {
      const column = columnOf(raw, declared.name);
      const symbol = makeSymbol({
        name: declared.name,
        kind: declared.kind,
        path,
        line: lineNumber,
        column,
        detail: raw.trim().slice(0, 240),
        documentation: commentAbove(lines, lineIndex),
        exported: declared.exported || (depth === 0 && code.startsWith("export")),
        isDefaultExport: declared.isDefault,
        member: declared.member && inClassBody,
        typeName: declared.typeName,
        bases: declared.bases,
        containerName: inClassBody ? classBlock?.name : undefined,
        scopeOwner,
      });
      if (symbol.member) {
        symbol.scopeStartLine = lineNumber;
        symbol.scopeEndLine = lineNumber;
      }
      symbols.push(symbol);
      const symbolIndex = symbols.length - 1;
      if (declared.parameters && !symbol.member) {
        pushParameters(symbols, path, masked, lines, lineIndex, declared.name, symbolIndex);
      }
      if (declared.opens === "class" || declared.opens === "function") {
        pending = { kind: declared.opens, symbolIndex, name: declared.name };
      } else {
        pending = null;
      }
    } else if (inClassBody) {
      const method = matchMethod(code);
      if (method) {
        const column = columnOf(raw, method.name);
        symbols.push(
          makeSymbol({
            name: method.name,
            kind: "method",
            path,
            line: lineNumber,
            column,
            detail: raw.trim().slice(0, 240),
            documentation: commentAbove(lines, lineIndex),
            exported: false,
            isDefaultExport: false,
            member: true,
            typeName: undefined,
            bases: [],
            containerName: classBlock?.name,
            scopeOwner: null,
          }),
        );
        pending = { kind: "function", symbolIndex: symbols.length - 1, name: method.name };
        pushParameters(symbols, path, masked, lines, lineIndex, method.name, symbols.length - 1);
      } else if (code.length > 0) {
        pending = null;
      }
    } else if (code.length > 0 && !code.startsWith("{")) {
      pending = null;
    }

    const nextDepth = depth + braceDelta(maskedLines[lineIndex] ?? "");
    if (pending && nextDepth > depth) {
      blocks.push({
        kind: pending.kind,
        bodyDepth: depth + 1,
        symbolIndex: pending.symbolIndex,
        name: pending.name,
      });
      pending = null;
    } else if (nextDepth > depth && !pending) {
      blocks.push({ kind: "other", bodyDepth: depth + 1, symbolIndex: null, name: "" });
    }
    depth = nextDepth;
    finishDepth(lineNumber);
  }
  finishDepth(lines.length);
  assignScopes(symbols, lines.length);
  return { path, symbols, imports, reexports, starExports };
}

interface DeclarationMatch {
  readonly name: string;
  readonly kind: CodeSymbolKind;
  readonly exported: boolean;
  readonly isDefault: boolean;
  readonly member: boolean;
  readonly typeName?: string | undefined;
  readonly bases: readonly string[];
  readonly parameters: boolean;
  readonly opens: "class" | "function" | null;
}

function matchJavaScriptDeclaration(code: string): DeclarationMatch | null {
  const exported = /^export\b/.test(code);
  const isDefault = /^export\s+default\b/.test(code);
  const prefix =
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|override\s+)*/;
  const name = "([A-Za-z_$][\\w$]*)";
  const functionMatch = new RegExp(`^${prefix.source}function\\s*\\*?\\s*${name}`).exec(code);
  if (functionMatch?.[1]) {
    return {
      name: functionMatch[1],
      kind: "function",
      exported,
      isDefault,
      member: false,
      bases: [],
      parameters: true,
      opens: "function",
    };
  }
  const classMatch = new RegExp(
    `^${prefix.source}class\\s+${name}(?:\\s+extends\\s+([A-Za-z_$][\\w$]*))?(?:\\s+implements\\s+([A-Za-z_$][\\w$]*(?:\\s*,\\s*[A-Za-z_$][\\w$]*)*))?`,
  ).exec(code);
  if (classMatch?.[1]) {
    return {
      name: classMatch[1],
      kind: "class",
      exported,
      isDefault,
      member: false,
      bases: basesFrom(classMatch[2], classMatch[3]),
      parameters: false,
      opens: "class",
    };
  }
  for (const kind of ["interface", "type", "enum", "namespace"] as const) {
    const keyword = kind === "namespace" ? "(?:namespace|module)" : kind;
    const match = new RegExp(
      `^${prefix.source}${keyword}\\s+${name}(?:\\s+extends\\s+([A-Za-z_$][\\w$]*(?:\\s*,\\s*[A-Za-z_$][\\w$]*)*))?`,
    ).exec(code);
    if (match?.[1]) {
      return {
        name: match[1],
        kind: kind === "namespace" ? "namespace" : kind,
        exported,
        isDefault: false,
        member: false,
        bases: basesFrom(undefined, match[2]),
        parameters: false,
        opens: kind === "enum" || kind === "namespace" || kind === "interface" ? "class" : null,
      };
    }
  }
  const valueMatch = new RegExp(
    `^${prefix.source}(const|let|var)\\s+${name}(?:\\s*:\\s*([A-Za-z_$][\\w$]*))?`,
  ).exec(code);
  if (valueMatch?.[2]) {
    const isFunction = /=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(
      code,
    );
    return {
      name: valueMatch[2],
      kind: valueMatch[1] === "const" ? "constant" : "variable",
      exported,
      isDefault: false,
      member: false,
      typeName: valueMatch[3],
      bases: [],
      parameters: isFunction,
      opens: isFunction ? "function" : null,
    };
  }
  const defaultValue = /^export\s+default\s+([A-Za-z_$][\w$]*)\b/.exec(code);
  if (defaultValue?.[1] && !JS_KEYWORDS.has(defaultValue[1])) {
    return {
      name: defaultValue[1],
      kind: "variable",
      exported: true,
      isDefault: true,
      member: false,
      bases: [],
      parameters: false,
      opens: null,
    };
  }
  return null;
}

function matchMethod(code: string): { name: string } | null {
  const match =
    /^(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+|abstract\s+|override\s+|get\s+|set\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^;\n]+>)?\s*\(/.exec(
      code,
    );
  if (!match?.[1] || JS_KEYWORDS.has(match[1].replace(/^#/, ""))) return null;
  return { name: match[1] };
}

function namedBinding(part: string): { imported: string; local: string } | null {
  const pieces = part
    .trim()
    .replace(/^type\s+/, "")
    .split(/\s+as\s+/);
  const imported = pieces[0]?.trim();
  const local = (pieces[1] ?? imported)?.trim();
  if (
    !imported ||
    !local ||
    !/^[A-Za-z_$][\w$]*$/.test(imported) ||
    !/^[A-Za-z_$][\w$]*$/.test(local)
  ) {
    return null;
  }
  return { imported, local };
}

function parseJavaScriptModuleStatement(
  _path: string,
  statement: string,
  line: number,
): { imports: ImportBinding[]; reexports: ReexportBinding[]; starExports: string[] } {
  const imports: ImportBinding[] = [];
  const reexports: ReexportBinding[] = [];
  const starExports: string[] = [];
  const specifier =
    /from\s+["']([^"']+)["']/.exec(statement)?.[1] ??
    /^import\s+["']([^"']+)["']/.exec(statement)?.[1];
  if (!specifier && statement.startsWith("export")) {
    const localClause = /\{([^}]*)\}/.exec(statement)?.[1];
    if (!localClause) return { imports, reexports, starExports };
    for (const part of localClause.split(",")) {
      const binding = namedBinding(part);
      if (!binding) continue;
      reexports.push({
        exported: binding.local,
        imported: binding.imported,
        specifier: null,
        span: spanOf(statement, binding.local, line),
        importedSpan: spanOf(statement, binding.imported, line),
      });
    }
    return { imports, reexports, starExports };
  }
  if (!specifier) return { imports, reexports, starExports };
  if (/^export\s+\*\s+from\b/.test(statement) || /^export\s+type\s+\*\s+from\b/.test(statement)) {
    starExports.push(specifier);
    return { imports, reexports, starExports };
  }
  const namespace = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(statement);
  if (namespace?.[1]) {
    const span = spanOf(statement, namespace[1], line);
    imports.push({
      local: namespace[1],
      imported: "*",
      specifier,
      localSpan: span,
      importedSpan: span,
      kind: "namespace",
    });
  }
  const defaults = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/.exec(statement);
  if (defaults?.[1] && defaults[1] !== "type" && !statement.includes("* as")) {
    const span = spanOf(statement, defaults[1], line);
    imports.push({
      local: defaults[1],
      imported: "default",
      specifier,
      localSpan: span,
      importedSpan: span,
      kind: "value",
    });
  }
  const clause = /\{([^}]*)\}/.exec(statement)?.[1];
  if (clause) {
    const kind = /\btype\b/.test(statement.slice(0, statement.indexOf("{"))) ? "type" : "value";
    for (const part of clause.split(",")) {
      const binding = namedBinding(part);
      if (!binding) continue;
      const { imported, local } = binding;
      const localSpan = spanOf(statement, local, line);
      const importedSpan = spanOf(statement, imported, line);
      if (statement.startsWith("export")) {
        reexports.push({
          exported: local,
          imported,
          specifier,
          span: localSpan,
          importedSpan,
        });
      } else {
        imports.push({
          local,
          imported,
          specifier,
          localSpan,
          importedSpan,
          kind,
        });
      }
    }
  }
  const starAlias = /export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/.exec(statement);
  if (starAlias?.[1]) {
    const span = spanOf(statement, starAlias[1], line);
    reexports.push({
      exported: starAlias[1],
      imported: "*",
      specifier,
      span,
      importedSpan: span,
    });
  }
  if (statement.startsWith("export") && clause && !/from\s+["']/.test(statement)) {
    for (const part of clause.split(",")) {
      const pieces = part.trim().split(/\s+as\s+/);
      const imported = pieces[0]?.trim();
      const exported = (pieces[1] ?? pieces[0])?.trim();
      if (!imported || !exported) continue;
      reexports.push({
        exported,
        imported,
        specifier: null,
        span: spanOf(statement, exported, line),
        importedSpan: spanOf(statement, imported, line),
      });
    }
  }
  return { imports, reexports, starExports };
}

function parsePython(path: string, text: string): ParsedFile {
  const masked = maskSource(text, "python");
  const lines = splitLines(text);
  const maskedLines = splitLines(masked);
  const symbols: MutableSymbol[] = [];
  const imports: ImportBinding[] = [];
  const stack: Array<{ indent: number; symbolIndex: number }> = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex] ?? "";
    const code = (maskedLines[lineIndex] ?? "").trim();
    const indent = raw.length - raw.trimStart().length;
    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent && code.length > 0) {
      const closed = stack.pop()!;
      const symbol = symbols[closed.symbolIndex];
      if (symbol) symbol.endLine = lineIndex;
    }
    const scopeOwner = stack[stack.length - 1]?.symbolIndex ?? null;
    const parent = scopeOwner === null ? null : symbols[scopeOwner];
    const defined =
      /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/.exec(code) ?? /^class\s+([A-Za-z_][\w]*)/.exec(code);
    if (defined?.[1]) {
      const kind = code.startsWith("class") || code.startsWith("class ") ? "class" : "function";
      const member = kind === "function" && parent?.kind === "class";
      const bases =
        kind === "class"
          ? (/\(([^)]*)\)/.exec(code)?.[1] ?? "")
              .split(",")
              .map((item) => item.trim())
              .filter((item) => /^[A-Za-z_][\w]*$/.test(item))
          : [];
      symbols.push(
        makeSymbol({
          name: defined[1],
          kind,
          path,
          line: lineIndex + 1,
          column: columnOf(raw, defined[1]),
          detail: raw.trim().slice(0, 240),
          documentation: commentAbove(lines, lineIndex, "#"),
          exported: !defined[1].startsWith("_"),
          isDefaultExport: false,
          member,
          typeName: undefined,
          bases,
          containerName: member ? parent?.name : undefined,
          scopeOwner: member ? null : scopeOwner,
        }),
      );
      stack.push({ indent, symbolIndex: symbols.length - 1 });
    }
    const fromImport = /^from\s+(\S+)\s+import\s+(.+)$/.exec(code);
    if (fromImport?.[1] && fromImport[2]) {
      for (const part of fromImport[2].split(",")) {
        const pieces = part.trim().split(/\s+as\s+/);
        const imported = pieces[0]?.trim();
        const local = (pieces[1] ?? pieces[0])?.trim();
        if (!imported || !local || imported === "*") continue;
        const span = {
          line: lineIndex + 1,
          column: columnOf(raw, local),
          endColumn: columnOf(raw, local) + local.length,
        };
        imports.push({
          local,
          imported,
          specifier: fromImport[1],
          localSpan: span,
          importedSpan: {
            line: lineIndex + 1,
            column: columnOf(raw, imported),
            endColumn: columnOf(raw, imported) + imported.length,
          },
          kind: "value",
        });
      }
    }
  }
  while (stack.length > 0) {
    const closed = stack.pop()!;
    const symbol = symbols[closed.symbolIndex];
    if (symbol) symbol.endLine = lines.length;
  }
  assignScopes(symbols, lines.length);
  return { path, symbols, imports, reexports: [], starExports: [] };
}

function parseBraceLanguage(path: string, text: string, language: CodeLanguage): ParsedFile {
  const masked = maskSource(text, language);
  const lines = splitLines(text);
  const maskedLines = splitLines(masked);
  const symbols: MutableSymbol[] = [];
  const imports: ImportBinding[] = [];
  let depth = 0;
  const blocks: Array<{ bodyDepth: number; symbolIndex: number | null }> = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex] ?? "";
    const code = (maskedLines[lineIndex] ?? "").trim();
    const declaration = matchBraceDeclaration(code, language);
    if (declaration) {
      symbols.push(
        makeSymbol({
          name: declaration.name,
          kind: declaration.kind,
          path,
          line: lineIndex + 1,
          column: columnOf(raw, declaration.name),
          detail: raw.trim().slice(0, 240),
          documentation: commentAbove(lines, lineIndex, language === "generic" ? "#" : "//"),
          exported: declaration.exported,
          isDefaultExport: false,
          member: declaration.member,
          typeName: undefined,
          bases: declaration.bases,
          containerName: undefined,
          scopeOwner: null,
        }),
      );
      if (declaration.opens) {
        blocks.push({ bodyDepth: depth + 1, symbolIndex: symbols.length - 1 });
      }
    }
    const useMatch = language === "rust" ? /^use\s+([^;]+);?/.exec(code) : null;
    if (useMatch?.[1]) imports.push(...rustUses(path, useMatch[1], lineIndex + 1, raw));
    depth += braceDelta(maskedLines[lineIndex] ?? "");
    while (blocks.length > 0 && blocks[blocks.length - 1]!.bodyDepth > depth) {
      const block = blocks.pop()!;
      if (block.symbolIndex !== null) {
        const symbol = symbols[block.symbolIndex];
        if (symbol) symbol.endLine = lineIndex + 1;
      }
    }
  }
  assignScopes(symbols, lines.length);
  return { path, symbols, imports, reexports: [], starExports: [] };
}

function matchBraceDeclaration(
  code: string,
  language: CodeLanguage,
): {
  name: string;
  kind: CodeSymbolKind;
  exported: boolean;
  member: boolean;
  bases: string[];
  opens: boolean;
} | null {
  if (language === "go") {
    const method = /^func\s+\([^)]+\)\s+([A-Za-z_]\w*)/.exec(code);
    if (method?.[1])
      return {
        name: method[1],
        kind: "method",
        exported: /^[A-Z]/.test(method[1]),
        member: true,
        bases: [],
        opens: true,
      };
    const fn = /^func\s+([A-Za-z_]\w*)/.exec(code);
    if (fn?.[1])
      return {
        name: fn[1],
        kind: "function",
        exported: /^[A-Z]/.test(fn[1]),
        member: false,
        bases: [],
        opens: true,
      };
    const type = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/.exec(code);
    if (type?.[1] && type[2]) {
      return {
        name: type[1],
        kind: type[2] === "struct" ? "struct" : "interface",
        exported: /^[A-Z]/.test(type[1]),
        member: false,
        bases: [],
        opens: true,
      };
    }
  }
  if (language === "rust") {
    const match =
      /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|mod|const|type)\s+([A-Za-z_]\w*)/.exec(
        code,
      );
    if (match?.[1] && match[2]) {
      const kind: CodeSymbolKind =
        match[1] === "fn"
          ? "function"
          : match[1] === "struct"
            ? "struct"
            : match[1] === "enum"
              ? "enum"
              : match[1] === "trait"
                ? "trait"
                : match[1] === "mod"
                  ? "module"
                  : match[1] === "const"
                    ? "constant"
                    : "type";
      return {
        name: match[2],
        kind,
        exported: code.startsWith("pub"),
        member: false,
        bases: [],
        opens: kind !== "constant" && kind !== "type",
      };
    }
  }
  const match =
    /^(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|open\s+|internal\s+|static\s+|async\s+|abstract\s+|final\s+)*(class|struct|enum|interface|trait|type|module|namespace|fn|fun|func|function|def|const|let|var)\s+([A-Za-z_]\w*)/.exec(
      code,
    );
  if (!match?.[1] || !match[2]) return null;
  const kind = keywordKind(match[1]);
  return {
    name: match[2],
    kind,
    exported: /^(?:export|pub|public)\b/.test(code),
    member: false,
    bases: [],
    opens: kind !== "constant" && kind !== "variable" && kind !== "type",
  };
}

function keywordKind(keyword: string): CodeSymbolKind {
  switch (keyword) {
    case "class":
      return "class";
    case "struct":
      return "struct";
    case "enum":
      return "enum";
    case "interface":
      return "interface";
    case "trait":
      return "trait";
    case "type":
      return "type";
    case "module":
    case "namespace":
      return "module";
    case "const":
      return "constant";
    case "let":
    case "var":
      return "variable";
    default:
      return "function";
  }
}

function rustUses(path: string, clause: string, line: number, raw: string): ImportBinding[] {
  const cleaned = clause.replace(/[{}]/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const full = parts[0];
  if (!full) return [];
  const segments = full.split("::");
  const imported = segments[segments.length - 1];
  if (
    !imported ||
    imported === "*" ||
    imported === "self" ||
    imported === "super" ||
    imported === "crate"
  )
    return [];
  const local = parts.includes("as") ? parts[parts.indexOf("as") + 1] : imported;
  if (!local) return [];
  const span = {
    line,
    column: columnOf(raw, local),
    endColumn: columnOf(raw, local) + local.length,
  };
  return [
    {
      local,
      imported,
      specifier: full,
      localSpan: span,
      importedSpan: span,
      kind: "value",
    },
  ];
}

type MutableSymbol = {
  -readonly [Key in keyof CodeSymbol]: CodeSymbol[Key];
} & {
  scopeOwner: number | null;
};

function makeSymbol(input: {
  name: string;
  kind: CodeSymbolKind;
  path: string;
  line: number;
  column: number;
  detail: string;
  documentation?: string | undefined;
  exported: boolean;
  isDefaultExport: boolean;
  member: boolean;
  typeName?: string | undefined;
  bases: readonly string[];
  containerName?: string | undefined;
  scopeOwner: number | null;
}): MutableSymbol {
  return {
    name: input.name,
    kind: input.kind,
    path: input.path,
    line: input.line,
    column: input.column,
    endColumn: input.column + input.name.length,
    endLine: input.line,
    scopeStartLine: input.line,
    scopeEndLine: input.line,
    ...(input.containerName ? { containerName: input.containerName } : {}),
    detail: input.detail,
    ...(input.documentation ? { documentation: input.documentation } : {}),
    exported: input.exported,
    isDefaultExport: input.isDefaultExport,
    member: input.member,
    ...(input.typeName ? { typeName: input.typeName } : {}),
    bases: input.bases,
    fileScoped: false,
    scopeOwner: input.scopeOwner,
  };
}

function assignScopes(symbols: readonly MutableSymbol[], lineCount: number): void {
  for (const symbol of symbols) {
    if (symbol.member) continue;
    const owner = symbol.scopeOwner === null ? null : symbols[symbol.scopeOwner];
    if (owner) {
      symbol.scopeStartLine = owner.line;
      symbol.scopeEndLine = Math.max(owner.endLine, symbol.line);
      symbol.fileScoped = false;
    } else {
      symbol.scopeStartLine = 1;
      symbol.scopeEndLine = lineCount;
      symbol.fileScoped = true;
    }
  }
}

function pushParameters(
  symbols: MutableSymbol[],
  path: string,
  masked: string,
  lines: readonly string[],
  lineIndex: number,
  ownerName: string,
  ownerIndex: number,
): void {
  const signature = collectSignature(masked, lineIndex);
  const params = parameterNames(signature.text);
  for (const name of params) {
    const column = columnOf(lines[lineIndex] ?? signature.text, name);
    symbols.push(
      makeSymbol({
        name,
        kind: "parameter",
        path,
        line: lineIndex + 1,
        column,
        detail: symbols[ownerIndex]?.detail ?? name,
        exported: false,
        isDefaultExport: false,
        member: false,
        bases: [],
        containerName: ownerName,
        scopeOwner: ownerIndex,
      }),
    );
  }
}

function parameterNames(signature: string): readonly string[] {
  const open = signature.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let end = open;
  for (let index = open; index < signature.length; index += 1) {
    const char = signature[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const body = signature.slice(open + 1, end);
  const names: string[] = [];
  let expect = true;
  let token = "";
  const flush = () => {
    if (expect && /^[A-Za-z_$][\w$]*$/.test(token) && !JS_KEYWORDS.has(token)) names.push(token);
    token = "";
  };
  for (const char of body) {
    if (/[A-Za-z0-9_$]/.test(char)) {
      token += char;
      continue;
    }
    flush();
    if (char === "," || char === "{" || char === "[") expect = true;
    else if (char === ":" || char === "=") expect = false;
  }
  flush();
  return names;
}

function resolveIdentifier(
  index: NavigationIndex,
  file: ParsedFile,
  ident: IdentifierAt,
  line: number,
  column: number,
): readonly CodeSymbol[] {
  if (ident.qualifier) {
    return resolveMember(index, file, ident.qualifier.name, ident.name, line);
  }
  const onImport = bindingAt(file, line, column);
  if (onImport)
    return followImport(index, file, onImport.imported, onImport.specifier, onImport.kind);
  const onReexport = reexportAt(file, line, column);
  if (onReexport) {
    if (onReexport.specifier === null) return resolveName(index, file, onReexport.imported, line);
    return followImport(index, file, onReexport.imported, onReexport.specifier, "value");
  }
  return resolveName(index, file, ident.name, line);
}

function resolveName(
  index: NavigationIndex,
  file: ParsedFile,
  name: string,
  line: number,
): readonly CodeSymbol[] {
  const locals = file.symbols.filter(
    (symbol) =>
      symbol.name === name &&
      !symbol.member &&
      symbol.scopeStartLine <= line &&
      symbol.scopeEndLine >= line,
  );
  if (locals.length > 0) {
    return [locals.toSorted((left, right) => rankSymbol(left, line) - rankSymbol(right, line))[0]!];
  }
  const imported = file.imports.find((item) => item.local === name);
  if (!imported) return [];
  return followImport(index, file, imported.imported, imported.specifier, imported.kind);
}

function followImport(
  index: NavigationIndex,
  file: ParsedFile,
  imported: string,
  specifier: string,
  kind: ImportBinding["kind"],
  depth = 0,
): readonly CodeSymbol[] {
  if (depth > 8) return [];
  const targetPath = index.links.get(linkKey(file.path, specifier));
  if (!targetPath) return [];
  const target = index.files.get(targetPath);
  if (!target) return [];
  if (kind === "namespace" || imported === "*") return [];
  const exported = exportedSymbols(target, imported);
  if (exported.length > 0) return exported;
  const reexport = target.reexports.find((item) => item.exported === imported);
  if (reexport) {
    if (reexport.specifier === null) return resolveName(index, target, reexport.imported, 1);
    return followImport(index, target, reexport.imported, reexport.specifier, "value", depth + 1);
  }
  for (const star of target.starExports) {
    const followed = followImport(index, target, imported, star, "value", depth + 1);
    if (followed.length > 0) return followed;
  }
  return [];
}

function resolveMember(
  index: NavigationIndex,
  file: ParsedFile,
  qualifier: string,
  name: string,
  line: number,
): readonly CodeSymbol[] {
  if (qualifier === "this" || qualifier === "super") {
    const owner = [...file.symbols]
      .reverse()
      .find((symbol) => symbol.kind === "class" && symbol.line <= line && symbol.endLine >= line);
    if (!owner) return [];
    const method = file.symbols.find(
      (symbol) => symbol.member && symbol.name === name && symbol.containerName === owner.name,
    );
    return method ? [method] : [];
  }
  const receivers = resolveName(index, file, qualifier, line);
  const receiver = receivers[0];
  if (!receiver) return [];
  if (file.imports.find((item) => item.local === qualifier)?.kind === "namespace") {
    const imported = file.imports.find((item) => item.local === qualifier);
    if (!imported) return [];
    return followImport(index, file, name, imported.specifier, "value");
  }
  const typeName = receiver.typeName ?? (receiver.kind === "class" ? receiver.name : undefined);
  if (!typeName) return [];
  const types =
    receiver.kind === "class" ? [receiver] : resolveName(index, file, typeName, receiver.line);
  const typeSymbol = types[0];
  if (!typeSymbol) return [];
  const typeFile = index.files.get(typeSymbol.path);
  const member = typeFile?.symbols.find(
    (symbol) => symbol.member && symbol.name === name && symbol.containerName === typeSymbol.name,
  );
  return member ? [member] : [];
}

function resolveTypeDefinitions(index: NavigationIndex, symbol: CodeSymbol): readonly CodeSymbol[] {
  if (
    symbol.kind === "class" ||
    symbol.kind === "interface" ||
    symbol.kind === "type" ||
    symbol.kind === "enum" ||
    symbol.kind === "trait" ||
    symbol.kind === "struct"
  ) {
    return [symbol];
  }
  if (!symbol.typeName) return [];
  const file = index.files.get(symbol.path);
  if (!file) return [];
  return resolveName(index, file, symbol.typeName, symbol.line);
}

function exportedSymbols(file: ParsedFile, name: string): readonly CodeSymbol[] {
  if (name === "default") return file.symbols.filter((symbol) => symbol.isDefaultExport);
  return file.symbols.filter((symbol) => symbol.exported && symbol.name === name && !symbol.member);
}

function highlightsInFile(
  index: NavigationIndex,
  file: ParsedFile,
  target: CodeSymbol,
): CodeSpan[] {
  const text = sourceText(index, file.path);
  if (!text) return [];
  const spans: CodeSpan[] = [];
  for (const ident of identifiersIn(text, file.path)) {
    if (ident.name !== target.name && ident.qualifier?.name !== target.name) {
      if (ident.name !== target.name) continue;
    }
    if (ident.name !== target.name) continue;
    const resolved = resolveIdentifier(index, file, ident, ident.line, ident.column);
    if (!resolved.some((symbol) => sameSymbol(symbol, target))) continue;
    spans.push({ line: ident.line, column: ident.column, endColumn: ident.endColumn });
    if (spans.length >= 200) break;
  }
  return spans;
}

function hoverFor(symbol: CodeSymbol): HoverInfo {
  return {
    name: symbol.name,
    kind: symbol.kind,
    detail: symbol.detail,
    ...(symbol.documentation ? { documentation: symbol.documentation } : {}),
    path: symbol.path,
    line: symbol.line,
    column: symbol.column,
  };
}

export function topLevelNamed(index: NavigationIndex, name: string): readonly CodeSymbol[] {
  const found: CodeSymbol[] = [];
  for (const file of index.files.values()) {
    for (const symbol of file.symbols) {
      if (!symbol.fileScoped || symbol.name !== name) continue;
      found.push(symbol);
    }
  }
  const exported = found.filter((symbol) => symbol.exported);
  return exported.length > 0 ? exported : found;
}

function sameSymbol(left: CodeSymbol, right: CodeSymbol): boolean {
  return (
    left.path === right.path &&
    left.line === right.line &&
    left.column === right.column &&
    left.name === right.name
  );
}

function rankSymbol(symbol: CodeSymbol, line: number): number {
  const size = symbol.scopeEndLine - symbol.scopeStartLine;
  const after = symbol.line > line ? 1 : 0;
  return size * 100_000 + after * 10_000 + Math.abs(symbol.line - line);
}

function bindingAt(file: ParsedFile, line: number, column: number): ImportBinding | null {
  return (
    file.imports.find(
      (item) =>
        spanContains(item.localSpan, line, column) || spanContains(item.importedSpan, line, column),
    ) ?? null
  );
}

function reexportAt(file: ParsedFile, line: number, column: number): ReexportBinding | null {
  return (
    file.reexports.find(
      (item) =>
        spanContains(item.span, line, column) || spanContains(item.importedSpan, line, column),
    ) ?? null
  );
}

function spanContains(span: CodeSpan, line: number, column: number): boolean {
  return span.line === line && column >= span.column && column < span.endColumn;
}

function identifiersIn(text: string, path: string): readonly IdentifierAt[] {
  const masked = cachedMask(text, languageOfPath(path));
  const found: IdentifierAt[] = [];
  const pattern = /[A-Za-z_$][\w$]*/g;
  let match = pattern.exec(masked);
  while (match) {
    const start = match.index;
    const position = positionOf(text, start);
    const ident = identifierAt(text, path, position.line, position.column);
    if (ident && ident.column === position.column) found.push(ident);
    match = pattern.exec(masked);
  }
  return found;
}

function identifierAt(
  text: string,
  path: string,
  line: number,
  column: number,
): IdentifierAt | null {
  const language = languageOfPath(path);
  const masked = cachedMask(text, language);
  const starts = lineStartOffsets(text);
  const lineStart = starts[line - 1];
  if (lineStart === undefined) return null;
  const lineEnd = starts[line] ?? text.length;
  let index = lineStart + column - 1;
  if (index > lineEnd) return null;
  if (index >= masked.length) index = masked.length - 1;
  if (index < lineStart) return null;
  if (
    !isIdentChar(masked[index] ?? "") &&
    index > lineStart &&
    isIdentChar(masked[index - 1] ?? "")
  )
    index -= 1;
  if (!isIdentChar(masked[index] ?? "") || masked[index] === " ") return null;
  let start = index;
  let end = index + 1;
  while (start > lineStart && isIdentChar(masked[start - 1] ?? "")) start -= 1;
  while (end < lineEnd && isIdentChar(masked[end] ?? "")) end += 1;
  const name = text.slice(start, end);
  if (!name || /^[0-9]/.test(name)) return null;
  if (language === "javascript" && (JS_KEYWORDS.has(name) || name === "this" || name === "super"))
    return null;
  let qualifier: IdentifierAt["qualifier"];
  let cursor = start - 1;
  while (cursor >= lineStart && masked[cursor] === " ") cursor -= 1;
  if (masked[cursor] === "." || (masked[cursor] === "?" && masked[cursor + 1] === ".")) {
    if (masked[cursor] === "?") cursor -= 1;
    cursor -= 1;
    while (cursor >= lineStart && masked[cursor] === " ") cursor -= 1;
    let qualEnd = cursor + 1;
    while (cursor >= lineStart && isIdentChar(masked[cursor] ?? "")) cursor -= 1;
    const qualStart = cursor + 1;
    const qualName = text.slice(qualStart, qualEnd);
    if (qualName && !/^[0-9]/.test(qualName)) {
      qualifier = {
        name: qualName,
        line,
        column: qualStart - lineStart + 1,
      };
    }
  }
  return {
    name,
    line,
    column: start - lineStart + 1,
    endColumn: end - lineStart + 1,
    ...(qualifier ? { qualifier } : {}),
  };
}

let maskedCache: { text: string; language: CodeLanguage; masked: string } | null = null;

function cachedMask(text: string, language: CodeLanguage): string {
  if (maskedCache?.text === text && maskedCache.language === language) return maskedCache.masked;
  const masked = maskSource(text, language);
  maskedCache = { text, language, masked };
  return masked;
}

function maskSource(text: string, language: CodeLanguage): string {
  const chars = [...text];
  let index = 0;
  const hash = language === "python" || language === "generic";
  const slash = language !== "python";
  while (index < chars.length) {
    const char = chars[index];
    const next = chars[index + 1];
    if (hash && char === "#") {
      const start = index;
      while (index < chars.length && chars[index] !== "\n") index += 1;
      blank(chars, start, index);
      continue;
    }
    if (slash && char === "/" && next === "/") {
      const start = index;
      while (index < chars.length && chars[index] !== "\n") index += 1;
      blank(chars, start, index);
      continue;
    }
    if (slash && char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < chars.length && !(chars[index] === "*" && chars[index + 1] === "/"))
        index += 1;
      index = Math.min(chars.length, index + 2);
      blank(chars, start, index);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      index = maskString(chars, index, language);
      continue;
    }
    index += 1;
  }
  return chars.join("");
}

function maskString(chars: string[], start: number, language: CodeLanguage): number {
  const quote = chars[start]!;
  const triple = language === "python" && chars[start + 1] === quote && chars[start + 2] === quote;
  let index = start + (triple ? 3 : 1);
  const blankRanges: Array<[number, number]> = [];
  let chunk = start;
  while (index < chars.length) {
    if (chars[index] === "\\") {
      index += 2;
      continue;
    }
    if (!triple && quote === "`" && chars[index] === "$" && chars[index + 1] === "{") {
      blankRanges.push([chunk, index]);
      index += 2;
      let depth = 1;
      while (index < chars.length && depth > 0) {
        if (chars[index] === "'" || chars[index] === '"' || chars[index] === "`") {
          index = maskString(chars, index, language);
          continue;
        }
        if (chars[index] === "{") depth += 1;
        if (chars[index] === "}") depth -= 1;
        index += 1;
      }
      chunk = index;
      continue;
    }
    if (
      triple &&
      chars[index] === quote &&
      chars[index + 1] === quote &&
      chars[index + 2] === quote
    ) {
      index += 3;
      break;
    }
    if (!triple && chars[index] === quote) {
      index += 1;
      break;
    }
    index += 1;
  }
  blankRanges.push([chunk, index]);
  for (const [from, to] of blankRanges) blank(chars, from, to);
  return index;
}

function blank(chars: string[], from: number, to: number): void {
  for (let index = from; index < to && index < chars.length; index += 1) {
    if (chars[index] !== "\n") chars[index] = " ";
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionOf(text: string, index: number): { line: number; column: number } {
  const starts = lineStartOffsets(text);
  let line = 0;
  for (let cursor = 0; cursor < starts.length; cursor += 1) {
    if (starts[cursor]! <= index) line = cursor;
    else break;
  }
  return { line: line + 1, column: index - starts[line]! + 1 };
}

function columnOf(line: string, name: string): number {
  const index = line.indexOf(name);
  return index < 0 ? 1 : index + 1;
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "{") delta += 1;
    else if (char === "}") delta -= 1;
  }
  return delta;
}

function isIdentChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function commentAbove(
  lines: readonly string[],
  lineIndex: number,
  marker = "//",
): string | undefined {
  const collected: string[] = [];
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed.length === 0) {
      if (collected.length > 0) break;
      continue;
    }
    if (trimmed.startsWith(marker)) {
      collected.push(trimmed.slice(marker.length).trim());
      continue;
    }
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/")) {
      collected.push(
        trimmed
          .replace(/^\/\*+|\*+\/$/g, "")
          .replace(/^\*\s?/, "")
          .trim(),
      );
      continue;
    }
    break;
  }
  const text = collected.reverse().filter(Boolean).join("\n");
  return text.length > 0 ? text.slice(0, 2000) : undefined;
}

function collectStatement(
  maskedLines: readonly string[],
  lines: readonly string[],
  start: number,
): { text: string; endLine: number } {
  let text = "";
  let end = start;
  for (let index = start; index < lines.length && index < start + 30; index += 1) {
    text += `${lines[index] ?? ""}\n`;
    end = index;
    const masked = maskedLines.slice(start, index + 1).join("\n");
    if (/;\s*$/.test(masked.trim()) || /from\s+["'][^"']+["']\s*;?\s*$/.test(masked.trim())) break;
    if (braceDelta(masked) === 0 && index > start && !masked.trim().endsWith(",")) break;
  }
  return { text: text.trim(), endLine: end + 1 };
}

function collectSignature(masked: string, lineIndex: number): { text: string } {
  const lines = splitLines(masked);
  return { text: lines.slice(lineIndex, lineIndex + 8).join("\n") };
}

function spanOf(statement: string, name: string, line: number): CodeSpan {
  const column = Math.max(1, statement.indexOf(name) + 1);
  return { line, column, endColumn: column + name.length };
}

function basesFrom(extend: string | undefined, implement: string | undefined): string[] {
  return [extend, ...(implement?.split(",") ?? [])]
    .map((item) => item?.trim())
    .filter((item): item is string => item !== undefined && /^[A-Za-z_$][\w$]*$/.test(item));
}

function extensionCandidates(base: string, language: CodeLanguage): readonly string[] {
  const normalized = normalizeNavigationPath(base);
  const extensions = language === "python" ? PY_EXTS : language === "rust" ? [".rs"] : JS_EXTS;
  if (extensions.some((extension) => normalized.endsWith(extension))) return [normalized];
  const files = extensions.map((extension) => normalized + extension);
  const indexes = extensions.map((extension) => `${normalized}/index${extension}`);
  if (language === "rust") return [`${normalized}.rs`, `${normalized}/mod.rs`];
  if (language === "python") return [`${normalized}.py`, `${normalized}/__init__.py`];
  return [...files, ...indexes];
}

function pythonCandidates(fromPath: string, specifier: string): readonly string[] {
  const dots = /^(-+|\.+)(.*)$/.exec(specifier);
  let directory = dirname(fromPath);
  let rest = specifier;
  if (dots) {
    const levels = dots[1]!.startsWith(".") ? dots[1]!.length : 0;
    for (let index = 1; index < levels; index += 1) directory = dirname(directory);
    rest = dots[2] ?? "";
  }
  const relative = rest.replaceAll(".", "/");
  const base = relative.length === 0 ? directory : joinPath(directory, relative);
  const rooted = relative.length === 0 ? "" : relative;
  return [
    ...extensionCandidates(base, "python"),
    ...(rooted ? extensionCandidates(rooted, "python") : []),
  ];
}

function rustCandidates(fromPath: string, specifier: string): readonly string[] {
  const segments = specifier.split("::").filter((segment) => segment.length > 0 && segment !== "*");
  const item = segments[segments.length - 1];
  const parents = segments.slice(0, -1);
  if (parents[0] === "crate") {
    return extensionCandidates(joinPath("src", parents.slice(1).join("/")), "rust").concat(
      item
        ? extensionCandidates(joinPath("src", parents.slice(1).concat(item).join("/")), "rust")
        : [],
    );
  }
  let directory = dirname(fromPath);
  const pathParts = [...parents];
  while (pathParts[0] === "super") {
    directory = dirname(directory);
    pathParts.shift();
  }
  if (pathParts[0] === "self") pathParts.shift();
  const base = joinPath(directory, pathParts.join("/"));
  return extensionCandidates(base, "rust");
}

function dirname(path: string): string {
  const normalized = normalizeNavigationPath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "" : normalized.slice(0, index);
}

function joinPath(left: string, right: string): string {
  const stack: string[] = [];
  for (const part of `${left}/${right}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

export function normalizeNavigationPath(path: string): string {
  return joinPath("", path.replaceAll("\\", "/"));
}

function linkKey(from: string, specifier: string): string {
  return `${from}\0${specifier}`;
}
