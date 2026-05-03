import type { Logger } from "../utils/logger.js";

/**
 * A single source contribution for a merge operation.
 * `sourceKey` is used in skipped-item logs so users can trace which source
 * provided what.
 */
export type SourceContribution<T> = {
  sourceKey: string;
  data: T;
};

/**
 * A skipped item — one that was rejected by a merge in favor of a higher-
 * precedence source (local > sources in declaration order).
 */
export type SkippedItem = {
  name: string;
  takenFrom: string;
  skippedFrom: string;
};

/**
 * Resolve named-item conflicts across sources for dir-based primitives
 * (skills, rules, commands, subagents).
 *
 * Precedence: items already in `localNames` win over any source. Among sources,
 * the first source contributing a given name wins; later sources are skipped.
 *
 * Returns a flat list of selected `(sourceKey, name, item)` tuples in stable
 * order, plus a `skipped` list for diagnostics. `localNames` are not included
 * in the result — the caller already has those.
 */
export function resolveNamedItemSources<T>(params: {
  localNames: Set<string>;
  sources: Array<SourceContribution<Map<string, T>>>;
  logger?: Logger;
}): {
  resolved: Array<{ sourceKey: string; name: string; item: T }>;
  skipped: SkippedItem[];
} {
  const { localNames, sources, logger } = params;
  const resolved: Array<{ sourceKey: string; name: string; item: T }> = [];
  const skipped: SkippedItem[] = [];
  const taken = new Map<string, string>(); // name -> sourceKey that took it

  for (const source of sources) {
    for (const [name, item] of source.data) {
      if (localNames.has(name)) {
        skipped.push({ name, takenFrom: "local", skippedFrom: source.sourceKey });
        logger?.debug(`Skipping "${name}" from ${source.sourceKey}: local item takes precedence.`);
        continue;
      }
      const existingTaker = taken.get(name);
      if (existingTaker !== undefined) {
        skipped.push({ name, takenFrom: existingTaker, skippedFrom: source.sourceKey });
        logger?.warn(
          `Skipping duplicate "${name}" from ${source.sourceKey}: already taken from ${existingTaker}.`,
        );
        continue;
      }
      taken.set(name, source.sourceKey);
      resolved.push({ sourceKey: source.sourceKey, name, item });
    }
  }

  return { resolved, skipped };
}

/**
 * MCP servers data.
 * Real shape: `{ mcpServers: { [name]: <server config> }, ... }`. We model it
 * loosely so the merge isn't coupled to the evolving server-config schema.
 */
export type McpData = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Merge MCP server definitions across base + sources.
 * Servers are merged at the top-level name. Base (local) wins; among sources,
 * the first source contributing a given server name wins.
 *
 * Other top-level keys are taken from base if present, else from the first
 * source that defines them.
 */
export function mergeMcpData(params: {
  base: McpData | undefined;
  sources: Array<SourceContribution<McpData>>;
  logger?: Logger;
}): McpData {
  const { base, sources, logger } = params;
  const result: McpData = base ? { ...base } : {};
  const baseServers: Record<string, unknown> = base?.mcpServers ? { ...base.mcpServers } : {};
  const mergedServers: Record<string, unknown> = { ...baseServers };
  const serverTaken = new Map<string, string>();
  for (const name of Object.keys(baseServers)) {
    serverTaken.set(name, "local");
  }

  for (const source of sources) {
    if (source.data.mcpServers) {
      for (const [name, config] of Object.entries(source.data.mcpServers)) {
        const existingTaker = serverTaken.get(name);
        if (existingTaker !== undefined) {
          logger?.debug(
            `MCP merge: skipping server "${name}" from ${source.sourceKey} (already taken from ${existingTaker}).`,
          );
          continue;
        }
        mergedServers[name] = config;
        serverTaken.set(name, source.sourceKey);
      }
    }
    for (const [key, value] of Object.entries(source.data)) {
      if (key === "mcpServers") continue;
      if (!(key in result)) {
        result[key] = value;
      }
    }
  }

  if (Object.keys(mergedServers).length > 0 || base?.mcpServers) {
    result.mcpServers = mergedServers;
  }
  return result;
}

/**
 * Permissions data.
 * Real shape: `{ permission: { [toolCategory]: { [pattern]: action } } }`.
 * Like MCP, modeled loosely for schema-evolution tolerance.
 */
export type PermissionsData = {
  permission?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

/**
 * Merge permissions across base + sources.
 * Tool categories are merged at the category name. Within a category, patterns
 * are merged at the pattern key. Base (local) wins at every level; among
 * sources, the first source contributing a given key wins.
 */
export function mergePermissionsData(params: {
  base: PermissionsData | undefined;
  sources: Array<SourceContribution<PermissionsData>>;
  logger?: Logger;
}): PermissionsData {
  const { base, sources, logger } = params;
  const result: PermissionsData = base ? { ...base } : {};
  const mergedPermission: Record<string, Record<string, unknown>> = {};
  const patternTaken = new Map<string, string>(); // "category/pattern" -> sourceKey

  if (base?.permission) {
    for (const [category, patterns] of Object.entries(base.permission)) {
      mergedPermission[category] = { ...patterns };
      for (const pattern of Object.keys(patterns)) {
        patternTaken.set(`${category}/${pattern}`, "local");
      }
    }
  }

  for (const source of sources) {
    if (source.data.permission) {
      for (const [category, patterns] of Object.entries(source.data.permission)) {
        const target = mergedPermission[category] ?? {};
        for (const [pattern, action] of Object.entries(patterns)) {
          const taken = patternTaken.get(`${category}/${pattern}`);
          if (taken !== undefined) {
            logger?.debug(
              `Permissions merge: skipping ${category}/${pattern} from ${source.sourceKey} (already taken from ${taken}).`,
            );
            continue;
          }
          target[pattern] = action;
          patternTaken.set(`${category}/${pattern}`, source.sourceKey);
        }
        mergedPermission[category] = target;
      }
    }
    for (const [key, value] of Object.entries(source.data)) {
      if (key === "permission") continue;
      if (!(key in result)) {
        result[key] = value;
      }
    }
  }

  if (Object.keys(mergedPermission).length > 0 || base?.permission) {
    result.permission = mergedPermission;
  }
  return result;
}

/**
 * Hooks data.
 *
 * Real shape (canonical):
 *   `{ version?, hooks: { [event]: HookDefinition[] }, <tool>: { hooks: { [event]: HookDefinition[] } } }`
 *
 * For tool-section keys (cursor, claudecode, copilot, ...), the inner shape is
 * `{ hooks: { [event]: HookDefinition[] } }`.
 *
 * Modeled loosely to tolerate schema evolution; the merger only depends on the
 * "hooks" sub-object having an array-per-event shape.
 */
export type HooksData = {
  version?: number;
  hooks?: Record<string, unknown[]>;
  [toolKey: string]: unknown;
};

/**
 * Merge hooks across base + sources.
 * For every top-level "hooks" record (root or nested under a tool section),
 * arrays are CONCATENATED — base first, then each source in declaration order.
 *
 * Concat (not local-wins) is intentional for hooks: every defined hook should
 * run, regardless of provenance. Within an event array, ordering is preserved.
 *
 * Top-level scalars (e.g. `version`) take the base's value if defined, else
 * the first source's value.
 */
export function mergeHooksData(params: {
  base: HooksData | undefined;
  sources: Array<SourceContribution<HooksData>>;
}): HooksData {
  const { base, sources } = params;
  const result: HooksData = {};

  // Carry top-level scalars from base (e.g. version), then fill missing ones
  // from sources in order.
  if (base) {
    for (const [key, value] of Object.entries(base)) {
      if (key === "hooks") continue;
      if (isToolSection(value)) continue;
      result[key] = value;
    }
  }
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.data)) {
      if (key === "hooks") continue;
      if (isToolSection(value)) continue;
      if (!(key in result)) {
        result[key] = value;
      }
    }
  }

  // Root `hooks` record.
  result.hooks = mergeHooksRecord(base?.hooks, sources, (data) => data.hooks);

  // Tool-section keys: union of all keys appearing across base + sources.
  const toolKeys = new Set<string>();
  if (base) {
    for (const [key, value] of Object.entries(base)) {
      if (isToolSection(value)) toolKeys.add(key);
    }
  }
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.data)) {
      if (isToolSection(value)) toolKeys.add(key);
    }
  }
  for (const toolKey of toolKeys) {
    const baseTool = isToolSection(base?.[toolKey]) ? base?.[toolKey] : undefined;
    const baseInner = baseTool?.hooks;
    const merged = mergeHooksRecord(baseInner, sources, (data) =>
      isToolSection(data[toolKey]) ? data[toolKey].hooks : undefined,
    );
    result[toolKey] = { hooks: merged };
  }

  return result;
}

/**
 * Merge a flat lines-list (e.g. .aiignore / .rulesyncignore).
 * Order: base lines first, then each source in declaration order.
 * Duplicate content lines (after trimming trailing whitespace) are removed;
 * comment lines starting with `#` and blank lines are preserved at first
 * occurrence. Consecutive blank lines collapse to a single blank line so
 * concatenating sources with trailing newlines doesn't produce ugly double-
 * blank section breaks.
 *
 * Returns the merged content joined by newlines (with a trailing newline).
 */
export function mergeIgnoreLines(params: {
  base: string | undefined;
  sources: Array<SourceContribution<string>>;
}): string {
  const { base, sources } = params;
  const seen = new Set<string>();
  const out: string[] = [];

  const consume = (content: string | undefined): void => {
    if (content === undefined) return;
    const lines = content.split(/\r?\n/);
    // A trailing newline at end-of-file produces an empty final element on
    // split; drop it so it isn't mistaken for an intentional blank line.
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line === "") {
        // Collapse consecutive blanks (and skip a leading blank).
        if (out.length === 0 || out[out.length - 1] === "") continue;
        out.push(line);
        continue;
      }
      if (line.startsWith("#")) {
        out.push(line);
        continue;
      }
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  };

  consume(base);
  for (const source of sources) {
    consume(source.data);
  }

  // Trim trailing blanks (cosmetic), then ensure a single trailing newline.
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out.length === 0 ? "" : out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeHooksRecord(
  base: Record<string, unknown[]> | undefined,
  sources: Array<SourceContribution<HooksData>>,
  extract: (data: HooksData) => Record<string, unknown[]> | undefined,
): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {};
  if (base) {
    for (const [event, items] of Object.entries(base)) {
      merged[event] = [...items];
    }
  }
  for (const source of sources) {
    const record = extract(source.data);
    if (!record) continue;
    for (const [event, items] of Object.entries(record)) {
      const existing = merged[event] ?? [];
      merged[event] = [...existing, ...items];
    }
  }
  return merged;
}

/**
 * Type-guard for the `<tool>: { hooks: { ... } }` shape.
 * A tool section is a plain object (not array, not null) that contains a
 * `hooks` property which is itself a plain object.
 */
function isToolSection(value: unknown): value is { hooks?: Record<string, unknown[]> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return "hooks" in value;
}
