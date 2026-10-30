import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const CODE_PATH_MAX_LENGTH = 512;

export const CodeSymbolKind = Schema.Literals([
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
]);
export type CodeSymbolKind = typeof CodeSymbolKind.Type;

const CodePath = TrimmedNonEmptyString.check(Schema.isMaxLength(CODE_PATH_MAX_LENGTH));

export const CodeNavigationSymbol = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: CodeSymbolKind,
  path: CodePath,
  line: PositiveInt,
  column: PositiveInt,
  endColumn: PositiveInt,
  endLine: PositiveInt,
  containerName: Schema.optional(Schema.String),
  detail: Schema.String.check(Schema.isMaxLength(500)),
  documentation: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  snippet: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type CodeNavigationSymbol = typeof CodeNavigationSymbol.Type;

export const CodeNavigationSpan = Schema.Struct({
  line: PositiveInt,
  column: PositiveInt,
  endColumn: PositiveInt,
});
export type CodeNavigationSpan = typeof CodeNavigationSpan.Type;

export const CodeNavigationHover = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: CodeSymbolKind,
  detail: Schema.String.check(Schema.isMaxLength(500)),
  documentation: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  path: CodePath,
  line: PositiveInt,
  column: PositiveInt,
});
export type CodeNavigationHover = typeof CodeNavigationHover.Type;

export const CodeNavigationReference = Schema.Struct({
  path: CodePath,
  line: PositiveInt,
  column: PositiveInt,
  endColumn: PositiveInt,
  lineContent: Schema.String.check(Schema.isMaxLength(240)),
});
export type CodeNavigationReference = typeof CodeNavigationReference.Type;

const position = {
  cwd: TrimmedNonEmptyString,
  relativePath: CodePath,
  line: PositiveInt,
  column: PositiveInt,
};

export const CodeNavigationRequest = Schema.Union([
  Schema.TaggedStruct("atPosition", position),
  Schema.TaggedStruct("references", position),
  Schema.TaggedStruct("implementations", position),
  Schema.TaggedStruct("documentSymbols", {
    cwd: TrimmedNonEmptyString,
    relativePath: CodePath,
  }),
  Schema.TaggedStruct("workspaceSymbols", {
    cwd: TrimmedNonEmptyString,
    query: Schema.String.check(Schema.isMaxLength(200)),
  }),
]);
export type CodeNavigationRequest = typeof CodeNavigationRequest.Type;

export const CodeNavigationResult = Schema.Union([
  Schema.TaggedStruct("atPosition", {
    identifier: Schema.NullOr(Schema.String),
    definitions: Schema.Array(CodeNavigationSymbol),
    typeDefinitions: Schema.Array(CodeNavigationSymbol),
    hover: Schema.NullOr(CodeNavigationHover),
    highlights: Schema.Array(CodeNavigationSpan),
    breadcrumbs: Schema.Array(CodeNavigationSymbol),
  }),
  Schema.TaggedStruct("references", {
    symbol: Schema.NullOr(CodeNavigationSymbol),
    references: Schema.Array(CodeNavigationReference),
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct("implementations", {
    symbol: Schema.NullOr(CodeNavigationSymbol),
    implementations: Schema.Array(CodeNavigationSymbol),
  }),
  Schema.TaggedStruct("documentSymbols", {
    symbols: Schema.Array(CodeNavigationSymbol),
  }),
  Schema.TaggedStruct("workspaceSymbols", {
    symbols: Schema.Array(CodeNavigationSymbol),
    truncated: Schema.Boolean,
  }),
]);
export type CodeNavigationResult = typeof CodeNavigationResult.Type;

export const CodeRenameRequest = Schema.Struct({
  ...position,
  newName: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type CodeRenameRequest = typeof CodeRenameRequest.Type;

export const CodeRenameResult = Schema.Struct({
  paths: Schema.Array(CodePath),
  occurrences: NonNegativeInt,
});
export type CodeRenameResult = typeof CodeRenameResult.Type;

export class ProjectCodeNavigationError extends Schema.TaggedError<ProjectCodeNavigationError>()(
  "ProjectCodeNavigationError",
  {
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
