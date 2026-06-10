import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { ToolDeps, ToolModule } from "./index.js";
import { loadSpecInputSchema } from "../schemas/load_spec.js";
import { fail, toCallToolResult } from "./result.js";
import { contentHash } from "../core/hashing.js";
import { indexDoc } from "../core/indexer.js";
import { normalize, NormalizeError } from "../core/normalizer.js";
import { formatVersionHandle } from "../core/resolver.js";
import type { Provenance, SourceType, SpecVersion } from "../store/store.js";

// Default raw-spec size cap — sits above realistic specs (enterprise specs
// are typically single-digit MB) to reject only pathological/accidental input
// that would amplify through parse→bundle→validate→index toward OOM.
// Override per call via ToolDeps.maxSpecBytes.
export const MAX_SPEC_BYTES = 16 * 1024 * 1024; // 16 MiB

// Thrown from the file pre-read guard; mapped to size_limit at the tool boundary.
// A separate type so the catch can distinguish it from io/parse errors.
class SizeLimitError extends Error {}

function sizeLimitMessage(actualBytes: number, maxBytes: number): string {
  const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `Spec is ${mib(actualBytes)}, exceeding the ${mib(maxBytes)} size limit — split the spec or raise the limit.`;
}

interface ResolvedSource {
  text: string;
  sourceType: SourceType;
  sourceUri: string | null;
  byteSize: number;
  basePath: string | undefined;
}

function detectSourceType(source: string, explicit: SourceType | undefined): SourceType {
  if (explicit) return explicit;
  if (/^https?:\/\//i.test(source)) return "url";
  if (existsSync(source)) return "file";
  return "inline";
}

// One-shot source resolution — no re-fetch after ingest.
async function resolveSource(
  source: string,
  explicit: SourceType | undefined,
  maxBytes: number,
): Promise<ResolvedSource> {
  const sourceType = detectSourceType(source, explicit);
  if (sourceType === "file") {
    // Reject an over-cap file by on-disk size BEFORE readFileSync slurps it
    // into memory — the only place we can guard the read itself.
    const size = statSync(source).size;
    if (size > maxBytes) throw new SizeLimitError(sizeLimitMessage(size, maxBytes));
    const text = readFileSync(source, "utf8");
    const abs = resolve(source);
    return { text, sourceType, sourceUri: abs, byteSize: Buffer.byteLength(text), basePath: abs };
  }
  if (sourceType === "url") {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetch failed (HTTP ${res.status}) for ${source}`);
    const text = await res.text();
    return { text, sourceType, sourceUri: source, byteSize: Buffer.byteLength(text), basePath: source };
  }
  return { text: source, sourceType, sourceUri: null, byteSize: Buffer.byteLength(source), basePath: undefined };
}

// Slugify info.title into a spec_id: NFKD-fold + strip combining marks (Café →
// cafe), lowercase, collapse every non-[a-z0-9] run to a single hyphen, trim
// hyphens. Returns "" when nothing usable remains.
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Deterministic, spec_id-scoped version_id. A pure content-hash id would
// collide if identical content loaded under two spec_ids; the NUL delimiter
// cannot appear in a slug or hex digest.
function makeVersionId(spec_id: string, content_hash: string): string {
  const NUL = String.fromCharCode(0);
  const digest = createHash("sha256").update(spec_id + NUL + content_hash).digest("hex");
  return `sv_${digest.slice(0, 24)}`;
}

async function handle(args: unknown, deps: ToolDeps) {
  const parsed = loadSpecInputSchema.safeParse(args);
  if (!parsed.success) {
    return toCallToolResult(fail("invalid_input", "Invalid load_spec input."), "Invalid load_spec input.");
  }
  const input = parsed.data;
  const { store } = deps;

  const maxBytes = deps.maxSpecBytes ?? MAX_SPEC_BYTES;

  try {
    const src = await resolveSource(input.source, input.source_type, maxBytes);
    // Universal size backstop: inline (always) + url (post-fetch). File is
    // already guarded pre-read in resolveSource; this re-check is harmless.
    if (src.byteSize > maxBytes) {
      const msg = sizeLimitMessage(src.byteSize, maxBytes);
      return toCallToolResult(fail("size_limit", msg), msg);
    }
    const { doc, specFormat, formatVersion, externalSources, warnings } = await normalize(
      src.text,
      src.basePath === undefined ? undefined : { basePath: src.basePath },
    );

    const info = (doc as { info?: { title?: unknown; version?: unknown } }).info ?? {};
    const title = typeof info.title === "string" ? info.title : undefined;

    // spec_id defaulting: an explicit arg wins; otherwise derive a slug from
    // info.title. `derived` gates the collision check below — an explicit
    // spec_id means the caller owns the namespace.
    let spec_id: string;
    let derived: boolean;
    if (input.spec_id != null) {
      spec_id = input.spec_id;
      derived = false;
    } else {
      const slug = title ? slugifyTitle(title) : "";
      if (!slug) {
        const msg = title
          ? `Could not derive a usable spec_id from info.title ${JSON.stringify(title)} — pass spec_id explicitly.`
          : "Could not derive spec_id: spec has no info.title — pass spec_id explicitly.";
        return toCallToolResult(fail("invalid_input", msg), msg);
      }
      spec_id = slug;
      derived = true;
    }
    const label = input.label ?? title ?? spec_id;
    const version_label =
      input.version_label ?? (info.version != null ? String(info.version) : null);

    const hash = contentHash(doc);
    const activate = input.activate ?? true;

    // Decide existing-vs-new BEFORE indexing: index with the version_id we'll
    // store under, and skip the doc-walk on already-indexed reloads.
    // makeVersionId is pure over (spec_id, hash), so for an existing version it
    // equals existing.version_id.
    const existing = store.getVersionByHash(spec_id, hash);
    const version_id = existing ? existing.version_id : makeVersionId(spec_id, hash);

    let version: SpecVersion;
    let wasExisting: boolean;
    let opCount: number;
    let tdCount: number;
    if (existing) {
      // Reload backfill: a version persisted before the indexer was implemented
      // would have an empty index. Reindex in place without creating a new version.
      const stale =
        store.countOperations(spec_id, version_id) === 0 &&
        store.countTypeDefs(spec_id, version_id) === 0;
      if (stale) {
        const { operations, typeDefs } = indexDoc(doc, { spec_id, version_id, specFormat });
        if (operations.length || typeDefs.length) {
          store.reindexVersion(spec_id, version_id, operations, typeDefs);
        }
      }
      version = existing;
      wasExisting = true;
      opCount = store.countOperations(spec_id, version_id);
      tdCount = store.countTypeDefs(spec_id, version_id);
    } else {
      // Derived-slug collision: the slug matches an existing spec established by
      // a DIFFERENT info.title — a genuine identity clash, not a new version.
      // Same title → new version (falls through); explicit spec_id → caller owns
      // it (derived === false); identical content → already returned above.
      if (derived) {
        const existingSpec = store.getSpec(spec_id);
        if (existingSpec && existingSpec.label.trim() !== (title ?? "").trim()) {
          const msg =
            `spec_id ${JSON.stringify(spec_id)} (derived from info.title ${JSON.stringify(title)}) ` +
            `is already used by a different spec titled ${JSON.stringify(existingSpec.label)}. ` +
            `Pass an explicit spec_id to load this spec separately.`;
          return toCallToolResult(fail("collision", msg), msg);
        }
      }
      const provenance: Provenance = {
        source_type: src.sourceType,
        source_uri: src.sourceUri,
        fetched_at: new Date().toISOString(),
        original_byte_size: src.byteSize,
        external_sources: externalSources,
      };
      const { operations, typeDefs } = indexDoc(doc, { spec_id, version_id, specFormat });
      // Snapshot first: a version row pointing at a missing snapshot is broken;
      // an orphan snapshot is harmless.
      store.writeSnapshot(hash, doc);
      version = store.putVersion({
        spec: { spec_id, label },
        version: {
          version_id,
          content_hash: hash,
          version_label,
          spec_format: specFormat,
          format_version: formatVersion,
          provenance,
        },
        operations,
        typeDefs,
      });
      wasExisting = false;
      opCount = operations.length;
      tdCount = typeDefs.length;
    }

    if (activate) store.setActive(spec_id, version.version_id);

    const payload = {
      ok: true as const,
      spec_id,
      version_id: version.version_id,
      content_hash: `sha256:${version.content_hash}`,
      version_label: version.version_label,
      spec_format: version.spec_format,
      format_version: version.format_version,
      activated: activate,
      was_existing: wasExisting,
      stats: { operations: opCount, type_defs: tdCount, warnings },
    };
    const summary = `Loaded ${spec_id} ${formatVersionHandle(version, store.listVersions(spec_id))} (${wasExisting ? "existing" : "new"}${activate ? ", active" : ""}).`;
    return toCallToolResult(payload, summary);
  } catch (e) {
    // Structured errors: NormalizeError carries a code + optional details;
    // everything else maps to io_error.
    if (e instanceof SizeLimitError) {
      return toCallToolResult(fail("size_limit", e.message), e.message);
    }
    if (e instanceof NormalizeError) {
      return toCallToolResult(fail(e.code, e.message, e.details), e.message);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return toCallToolResult(fail("io_error", msg), msg);
  }
}

export const loadSpecTool: ToolModule = {
  name: "load_spec",
  title: "Load spec",
  description:
    "Ingest, normalize, index, and (by default) activate an OpenAPI spec version.",
  inputSchema: loadSpecInputSchema,
  handler: handle,
};
