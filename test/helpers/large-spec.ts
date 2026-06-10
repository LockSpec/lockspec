// Deterministic synthetic OpenAPI 3.1 generator for scale benchmarking
// (size guard + recall/memory characterization). No third-party spec is vendored;
// this generator IS the fixture — deterministic and inspectable, kept in code
// rather than as a committed multi-MB blob.
//
// Produces many resources × 5 CRUD operations, each with summary/tags and a
// referenced component schema, so find_endpoint has substantive text to rank at
// scale. A few distinctive ANCHOR resources (unique tokens) are the stable recall
// targets; the bulk `entityN` resources provide volume.
//
// NOTE: this measures ranking-correctness at scale, NOT real-world paraphrase
// recall (the synthetic names are not paraphrased intent).

/** Distinctive single-use resource nouns — unambiguous recall targets. */
export const LARGE_SPEC_ANCHORS = [
  "telescope",
  "umbrella",
  "volcano",
  "lighthouse",
  "kangaroo",
] as const;

export interface LargeSpecOptions {
  /** Number of bulk `entityN` resources (each → 5 ops). Anchors are added on top. Default 600. */
  resources?: number;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function schemaFor(noun: string): object {
  return {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "string", description: `Unique identifier of the ${noun}` },
      name: { type: "string", description: `Display name of the ${noun}` },
      description: { type: "string", description: `Free-text description of the ${noun}` },
      created_at: { type: "string", format: "date-time" },
      tags: { type: "array", items: { type: "string" } },
    },
  };
}

function resourceOps(noun: string): Array<[string, object]> {
  const Rc = cap(noun);
  const collection = `/${noun}s`;
  const item = `${collection}/{id}`;
  const ref = { $ref: `#/components/schemas/${Rc}` };
  const okOne = (desc: string) => ({
    "200": { description: desc, content: { "application/json": { schema: ref } } },
  });
  const body = { required: true, content: { "application/json": { schema: ref } } };
  return [
    [
      collection,
      {
        post: { operationId: `create${Rc}`, summary: `Create a ${noun}`, tags: [Rc], requestBody: body, responses: okOne(`The created ${noun}`) },
        get: {
          operationId: `list${Rc}`,
          summary: `List ${noun}s`,
          tags: [Rc],
          responses: { "200": { description: `A list of ${noun}s`, content: { "application/json": { schema: { type: "array", items: ref } } } } },
        },
      },
    ],
    [
      item,
      {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { operationId: `get${Rc}`, summary: `Get a ${noun} by id`, tags: [Rc], responses: okOne(`The ${noun}`) },
        put: { operationId: `update${Rc}`, summary: `Update a ${noun}`, tags: [Rc], requestBody: body, responses: okOne(`The updated ${noun}`) },
        delete: { operationId: `delete${Rc}`, summary: `Delete a ${noun}`, tags: [Rc], responses: { "204": { description: `The ${noun} was deleted` } } },
      },
    ],
  ];
}

/** Build a deterministic large, valid OpenAPI 3.1 document (default ~3025 operations). */
export function makeLargeSpec(opts?: LargeSpecOptions): Record<string, unknown> {
  const bulk = opts?.resources ?? 600;
  const nouns = [
    ...LARGE_SPEC_ANCHORS,
    ...Array.from({ length: bulk }, (_, i) => `entity${i}`),
  ];
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  for (const noun of nouns) {
    for (const [p, item] of resourceOps(noun)) paths[p] = item;
    schemas[cap(noun)] = schemaFor(noun);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Large Synthetic API",
      version: "1.0.0",
      description: "Generated fixture for the large-spec size/recall/memory benchmark.",
    },
    paths,
    components: { schemas },
  };
}
