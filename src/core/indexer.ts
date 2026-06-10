import type { NormalizedDoc, Operation, SpecFormat, TypeDef } from "../store/store.js";
import { escapePointer, isObj, type Obj } from "./json-pointer.js";

// An allowlist of OpenAPI 3.x Path Item Object fixed fields that name an operation
// — NOT Object.keys(pathItem), which would also pull in parameters/summary/$ref.
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export interface IndexContext {
  spec_id: string;
  version_id: string;
  specFormat: SpecFormat;
}

export interface IndexResult {
  operations: Operation[];
  typeDefs: TypeDef[];
}

export function indexDoc(doc: NormalizedDoc, ctx: IndexContext): IndexResult {
  const root = isObj(doc) ? doc : {};
  return {
    operations: ctx.specFormat === "openapi" ? indexOperations(root, ctx) : [],
    typeDefs: indexTypeDefs(root, ctx),
  };
}

function indexOperations(root: Obj, ctx: IndexContext): Operation[] {
  const paths = root.paths;
  if (!isObj(paths)) return [];

  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;

      const METHOD = method.toUpperCase();
      const ptrBase = `/paths/${escapePointer(path)}/${method}`;
      operations.push({
        spec_id: ctx.spec_id,
        version_id: ctx.version_id,
        operation_key: `${METHOD}:${path}`,
        operation_id: typeof op.operationId === "string" ? op.operationId : null,
        summary: typeof op.summary === "string" ? op.summary : null,
        description: typeof op.description === "string" ? op.description : null,
        tags: stringArray(op.tags),
        deprecated: op.deprecated === true,
        openapi: {
          method: METHOD,
          path,
          pointers: {
            params: `${ptrBase}/parameters`,
            requestBody: `${ptrBase}/requestBody`,
            responses: `${ptrBase}/responses`,
          },
        },
      });
    }
  }
  return operations;
}

// v1 scope: components.schemas only — broader component kinds extend later.
function indexTypeDefs(root: Obj, ctx: IndexContext): TypeDef[] {
  const components = root.components;
  const schemas = isObj(components) ? components.schemas : undefined;
  if (!isObj(schemas)) return [];

  const typeDefs: TypeDef[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    typeDefs.push({
      spec_id: ctx.spec_id,
      version_id: ctx.version_id,
      name,
      kind: deriveKind(schema),
      pointer: `/components/schemas/${escapePointer(name)}`,
      description: isObj(schema) && typeof schema.description === "string" ? schema.description : null,
    });
  }
  return typeDefs;
}

// Display-only kind. A `type` array yields its first non-"null" member
// (`["string","null"]` → "string").
function deriveKind(schema: unknown): string {
  if (!isObj(schema)) return "object";
  if (Array.isArray(schema.enum)) return "enum";
  const t = schema.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    const named = t.find((m) => typeof m === "string" && m !== "null");
    if (typeof named === "string") return named;
  }
  return "object";
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
