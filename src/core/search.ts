import type { Operation, Store, TypeDef } from "../store/store.js";

const DEFAULT_LIMIT = 10;
const FUZZY_THRESHOLD = 0.34;

interface RankFields {
  exact: string[];
  prefix: string[];
  /** Trigram-Dice fuzzy text fields — the typo fallback. */
  fuzzy: string[];
  /** Raw FTS score if this item was an FTS hit; UNDEFINED if not (never 0 — a 0
   *  would register a false hit and skew the intra-FTS normalization). */
  fts?: number;
  tiebreak: string;
}

// Tier → output-score band, all within (0,1] and non-overlapping, so a single
// score-desc sort yields exact > prefix > FTS > fuzzy:
//   exact (1) > prefix (0.85) > FTS (0.4, 0.8] > fuzzy (0.1, 0.4].
// An empty query skips exact/prefix, and dice("") = 0 < threshold → no results.
function rankItems<T>(
  items: T[],
  rawQuery: string,
  fields: (item: T) => RankFields,
  limit: number,
): { ranked: { item: T; score: number }[]; truncated: boolean } {
  const qLower = rawQuery.trim().toLowerCase();
  const extracted = items.map(fields);
  const maxFts = Math.max(0, ...extracted.filter((f) => f.fts !== undefined).map((f) => f.fts!));

  const scored: { item: T; score: number; tiebreak: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const f = extracted[i]!;
    let score: number;
    if (qLower !== "" && f.exact.some((s) => s.toLowerCase() === qLower)) {
      score = 1;
    } else if (qLower !== "" && f.prefix.some((s) => s.toLowerCase().startsWith(qLower))) {
      score = 0.85;
    } else if (f.fts !== undefined) {
      const norm = maxFts > 0 ? f.fts / maxFts : 1;
      score = 0.4 + 0.4 * norm;
    } else {
      const sim = bestDice(qLower, f.fuzzy);
      if (sim < FUZZY_THRESHOLD) continue;
      score = 0.1 + 0.3 * sim;
    }
    scored.push({ item: items[i]!, score, tiebreak: f.tiebreak });
  }

  scored.sort((a, b) => b.score - a.score || a.tiebreak.localeCompare(b.tiebreak));
  const truncated = scored.length > limit;
  return {
    ranked: scored.slice(0, limit).map(({ item, score }) => ({ item, score })),
    truncated,
  };
}

export function searchEndpoints(
  store: Store,
  target: { spec_id: string; version_id: string },
  opts: FindEndpointOptions,
): FindEndpointResult {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const q = opts.query.trim();

  const methodFilter = opts.method?.toUpperCase();
  const candidates = store
    .getOperations(target.spec_id, target.version_id)
    .filter((op): op is Operation & { openapi: NonNullable<Operation["openapi"]> } => op.openapi != null)
    .filter((op) => {
      if (methodFilter && op.openapi.method.toUpperCase() !== methodFilter) return false;
      if (opts.tag && !op.tags.includes(opts.tag)) return false;
      if (op.deprecated && !opts.includeDeprecated) return false;
      return true;
    });

  // FTS hits from the Store seam, restricted to the filtered candidate set.
  const eligibleKeys = new Set(candidates.map((op) => op.operation_key));
  const ftsScore = new Map<string, number>();
  for (const hit of store.searchOps(target.spec_id, target.version_id, q)) {
    if (eligibleKeys.has(hit.operation_key)) ftsScore.set(hit.operation_key, hit.score);
  }

  const { ranked, truncated } = rankItems(candidates, q, (op) => {
    const opId = op.operation_id;
    return {
      exact: str(opId, op.openapi.path, op.operation_key),
      prefix: str(opId, op.openapi.path),
      fuzzy: str(opId, op.openapi.path, op.summary),
      fts: ftsScore.get(op.operation_key),
      tiebreak: op.operation_key,
    };
  }, limit);

  const results = ranked.map(({ item: op, score }) => ({
    operation_key: op.operation_key,
    operation_id: op.operation_id,
    method: op.openapi!.method,
    path: op.openapi!.path,
    summary: op.summary ?? null,
    tags: op.tags,
    deprecated: op.deprecated,
    score,
  }));
  return { results, truncated };
}

// In-memory ranking over getTypeDefs — the per-version corpus is small.
export function searchTypes(
  store: Store,
  target: { spec_id: string; version_id: string },
  opts: FindTypeOptions,
): FindTypeResult {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const typeDefs = store.getTypeDefs(target.spec_id, target.version_id);

  const { ranked, truncated } = rankItems(typeDefs, opts.query, (td) => ({
    exact: [td.name],
    prefix: [td.name],
    fuzzy: [td.name],
    tiebreak: td.name,
  }), limit);

  const results = ranked.map(({ item: td, score }) => ({
    name: td.name,
    kind: td.kind,
    score,
  }));
  return { results, truncated };
}

function str(...xs: (string | null | undefined)[]): string[] {
  return xs.filter((x): x is string => typeof x === "string");
}

function bestDice(qLower: string, fields: string[]): number {
  let best = 0;
  for (const f of fields) best = Math.max(best, dice(qLower, f.toLowerCase()));
  return best;
}

function trigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
  return set;
}

function dice(a: string, b: string): number {
  if (a === b) return a === "" ? 0 : 1;
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export interface FindEndpointOptions {
  query: string;
  method?: string;
  tag?: string;
  includeDeprecated?: boolean;
  limit?: number;
}

/** Compact result row — never a full signature. */
export interface EndpointResultRow {
  operation_key: string;
  operation_id: string | null;
  method: string;
  path: string;
  summary: string | null;
  tags: string[];
  deprecated: boolean;
  score: number;
}

export interface FindEndpointResult {
  results: EndpointResultRow[];
  truncated: boolean;
}

export interface FindTypeOptions {
  query: string;
  limit?: number;
}

/** Compact result row — never a full schema dump. */
export interface TypeResultRow {
  name: string;
  kind: string;
  score: number;
}

export interface FindTypeResult {
  results: TypeResultRow[];
  truncated: boolean;
}
