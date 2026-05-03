import { describe, expect, it } from "vitest";

import { createMockLogger } from "../test-utils/mock-logger.js";
import {
  type HooksData,
  type McpData,
  mergeHooksData,
  mergeIgnoreLines,
  mergeMcpData,
  mergePermissionsData,
  type PermissionsData,
  resolveNamedItemSources,
  type SourceContribution,
} from "./merge-strategies.js";

describe("resolveNamedItemSources", () => {
  it("returns local-skipping entries for items present in localNames", () => {
    const sourceA = new Map<string, number>([
      ["alpha", 1],
      ["beta", 2],
    ]);
    const result = resolveNamedItemSources({
      localNames: new Set(["alpha"]),
      sources: [{ sourceKey: "src-a", data: sourceA }],
    });

    expect(result.resolved).toEqual([{ sourceKey: "src-a", name: "beta", item: 2 }]);
    expect(result.skipped).toEqual([{ name: "alpha", takenFrom: "local", skippedFrom: "src-a" }]);
  });

  it("first source wins when multiple sources contribute the same name", () => {
    const sourceA = new Map<string, string>([["dup", "from-a"]]);
    const sourceB = new Map<string, string>([
      ["dup", "from-b"],
      ["only-b", "b-only"],
    ]);

    const result = resolveNamedItemSources({
      localNames: new Set<string>(),
      sources: [
        { sourceKey: "src-a", data: sourceA },
        { sourceKey: "src-b", data: sourceB },
      ],
    });

    expect(result.resolved).toEqual([
      { sourceKey: "src-a", name: "dup", item: "from-a" },
      { sourceKey: "src-b", name: "only-b", item: "b-only" },
    ]);
    expect(result.skipped).toEqual([{ name: "dup", takenFrom: "src-a", skippedFrom: "src-b" }]);
  });

  it("preserves source order in the resolved list", () => {
    const sources: Array<SourceContribution<Map<string, number>>> = [
      { sourceKey: "src-a", data: new Map([["x", 1]]) },
      { sourceKey: "src-b", data: new Map([["y", 2]]) },
      { sourceKey: "src-c", data: new Map([["z", 3]]) },
    ];

    const result = resolveNamedItemSources({
      localNames: new Set<string>(),
      sources,
    });

    expect(result.resolved.map((r) => r.name)).toEqual(["x", "y", "z"]);
  });

  it("logs warn for cross-source duplicates and debug for local-shadow", () => {
    const logger = createMockLogger();
    resolveNamedItemSources({
      localNames: new Set(["local-name"]),
      sources: [
        { sourceKey: "src-a", data: new Map([["dup", 1]]) },
        {
          sourceKey: "src-b",
          data: new Map([
            ["dup", 2],
            ["local-name", 3],
          ]),
        },
      ],
      logger,
    });

    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns empty arrays when all sources are empty", () => {
    const result = resolveNamedItemSources({
      localNames: new Set<string>(),
      sources: [{ sourceKey: "src-a", data: new Map() }],
    });
    expect(result.resolved).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe("mergeMcpData", () => {
  it("returns empty object when there is no base and no sources", () => {
    const result = mergeMcpData({ base: undefined, sources: [] });
    expect(result).toEqual({});
  });

  it("preserves base servers and merges in source servers under new names", () => {
    const base: McpData = {
      mcpServers: { local: { command: "local-cmd" } },
    };
    const source: McpData = {
      mcpServers: { remote: { command: "remote-cmd" } },
    };
    const result = mergeMcpData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
    });

    expect(result.mcpServers).toEqual({
      local: { command: "local-cmd" },
      remote: { command: "remote-cmd" },
    });
  });

  it("base wins for identically-named server, logs at debug", () => {
    const logger = createMockLogger();
    const base: McpData = { mcpServers: { foo: { command: "base" } } };
    const source: McpData = { mcpServers: { foo: { command: "source" } } };

    const result = mergeMcpData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
      logger,
    });

    expect(result.mcpServers).toEqual({ foo: { command: "base" } });
    expect(logger.debug).toHaveBeenCalled();
  });

  it("first source wins among multiple sources contributing same server", () => {
    const sourceA: McpData = { mcpServers: { foo: { command: "from-a" } } };
    const sourceB: McpData = {
      mcpServers: { foo: { command: "from-b" }, bar: { command: "b-only" } },
    };

    const result = mergeMcpData({
      base: undefined,
      sources: [
        { sourceKey: "src-a", data: sourceA },
        { sourceKey: "src-b", data: sourceB },
      ],
    });

    expect(result.mcpServers).toEqual({
      foo: { command: "from-a" },
      bar: { command: "b-only" },
    });
  });

  it("preserves top-level non-server keys with base-wins semantics", () => {
    const base: McpData = { mcpServers: {}, version: "base-v" };
    const source: McpData = { mcpServers: {}, version: "source-v", extra: 7 };

    const result = mergeMcpData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
    });

    expect(result.version).toBe("base-v");
    expect(result.extra).toBe(7);
  });

  it("does not introduce mcpServers if neither base nor any source defines it", () => {
    const result = mergeMcpData({
      base: { other: 1 },
      sources: [{ sourceKey: "src-a", data: { other2: 2 } }],
    });
    expect(result.mcpServers).toBeUndefined();
    expect(result.other).toBe(1);
    expect(result.other2).toBe(2);
  });

  it("includes empty mcpServers if base defined an empty one", () => {
    const result = mergeMcpData({
      base: { mcpServers: {} },
      sources: [],
    });
    expect(result.mcpServers).toEqual({});
  });
});

describe("mergePermissionsData", () => {
  it("returns empty object with no base and no sources", () => {
    const result = mergePermissionsData({ base: undefined, sources: [] });
    expect(result).toEqual({});
  });

  it("merges new categories from sources alongside base categories", () => {
    const base: PermissionsData = {
      permission: { read: { "*.md": "allow" } },
    };
    const source: PermissionsData = {
      permission: { write: { "*.txt": "deny" } },
    };

    const result = mergePermissionsData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
    });

    expect(result.permission).toEqual({
      read: { "*.md": "allow" },
      write: { "*.txt": "deny" },
    });
  });

  it("merges new patterns within an existing category", () => {
    const base: PermissionsData = {
      permission: { read: { "*.md": "allow" } },
    };
    const source: PermissionsData = {
      permission: { read: { "*.txt": "allow" } },
    };

    const result = mergePermissionsData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
    });

    expect(result.permission).toEqual({
      read: { "*.md": "allow", "*.txt": "allow" },
    });
  });

  it("base wins on (category, pattern) collision", () => {
    const logger = createMockLogger();
    const base: PermissionsData = {
      permission: { read: { "*.md": "allow" } },
    };
    const source: PermissionsData = {
      permission: { read: { "*.md": "deny" } },
    };

    const result = mergePermissionsData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
      logger,
    });

    expect(result.permission).toEqual({ read: { "*.md": "allow" } });
    expect(logger.debug).toHaveBeenCalled();
  });

  it("first source wins on cross-source collision", () => {
    const sourceA: PermissionsData = {
      permission: { read: { "*.md": "allow" } },
    };
    const sourceB: PermissionsData = {
      permission: { read: { "*.md": "deny", "*.txt": "allow" } },
    };

    const result = mergePermissionsData({
      base: undefined,
      sources: [
        { sourceKey: "src-a", data: sourceA },
        { sourceKey: "src-b", data: sourceB },
      ],
    });

    expect(result.permission).toEqual({
      read: { "*.md": "allow", "*.txt": "allow" },
    });
  });

  it("preserves top-level non-permission keys", () => {
    const base: PermissionsData = { permission: {}, version: 1 };
    const source: PermissionsData = { permission: {}, extra: "x" };

    const result = mergePermissionsData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
    });

    expect(result.version).toBe(1);
    expect(result.extra).toBe("x");
  });
});

describe("mergeHooksData", () => {
  it("returns an object with empty hooks when there is no base or sources", () => {
    const result = mergeHooksData({ base: undefined, sources: [] });
    expect(result.hooks).toEqual({});
  });

  it("concatenates root-level hooks arrays in base-then-source order", () => {
    const base: HooksData = {
      hooks: { onSave: [{ id: "base-1" }] },
    };
    const sourceA: HooksData = {
      hooks: { onSave: [{ id: "a-1" }, { id: "a-2" }] },
    };
    const sourceB: HooksData = {
      hooks: { onSave: [{ id: "b-1" }] },
    };

    const result = mergeHooksData({
      base,
      sources: [
        { sourceKey: "src-a", data: sourceA },
        { sourceKey: "src-b", data: sourceB },
      ],
    });

    expect(result.hooks).toEqual({
      onSave: [{ id: "base-1" }, { id: "a-1" }, { id: "a-2" }, { id: "b-1" }],
    });
  });

  it("merges different events independently", () => {
    const base: HooksData = { hooks: { onSave: [{ id: "save-base" }] } };
    const source: HooksData = { hooks: { onLoad: [{ id: "load-src" }] } };

    const result = mergeHooksData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
    });

    expect(result.hooks).toEqual({
      onSave: [{ id: "save-base" }],
      onLoad: [{ id: "load-src" }],
    });
  });

  it("merges tool-section hooks (e.g. claudecode.hooks)", () => {
    const base: HooksData = {
      claudecode: { hooks: { onSave: [{ id: "cc-base" }] } },
    };
    const source: HooksData = {
      claudecode: { hooks: { onSave: [{ id: "cc-src" }] } },
    };

    const result = mergeHooksData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
    });

    const claudecode = result.claudecode as { hooks: Record<string, unknown[]> };
    expect(claudecode.hooks).toEqual({
      onSave: [{ id: "cc-base" }, { id: "cc-src" }],
    });
  });

  it("creates a tool section even if only sources contribute it", () => {
    const result = mergeHooksData({
      base: undefined,
      sources: [
        {
          sourceKey: "src-a",
          data: { cursor: { hooks: { onSave: [{ id: "cur" }] } } },
        },
      ],
    });

    const cursor = result.cursor as { hooks: Record<string, unknown[]> };
    expect(cursor.hooks).toEqual({ onSave: [{ id: "cur" }] });
  });

  it("preserves top-level scalars (e.g. version) with base-wins", () => {
    const base: HooksData = { version: 1 };
    const source: HooksData = { version: 2, extra: "x" };

    const result = mergeHooksData({
      base,
      sources: [{ sourceKey: "src-a", data: source }],
    });

    expect(result.version).toBe(1);
    expect(result.extra).toBe("x");
  });

  it("source scalar fills missing base scalar", () => {
    const result = mergeHooksData({
      base: undefined,
      sources: [{ sourceKey: "src-a", data: { version: 7 } }],
    });
    expect(result.version).toBe(7);
  });
});

describe("mergeIgnoreLines", () => {
  it("returns empty string when there is nothing to merge", () => {
    expect(mergeIgnoreLines({ base: undefined, sources: [] })).toBe("");
  });

  it("merges base then sources, deduplicating content lines", () => {
    const result = mergeIgnoreLines({
      base: "node_modules\n.env\n",
      sources: [
        { sourceKey: "src-a", data: ".env\nbuild\n" },
        { sourceKey: "src-b", data: "dist\nbuild\n" },
      ],
    });
    expect(result).toBe("node_modules\n.env\nbuild\ndist\n");
  });

  it("preserves comment and blank lines as-is at each occurrence", () => {
    const result = mergeIgnoreLines({
      base: "# base header\n\nfoo\n",
      sources: [{ sourceKey: "src-a", data: "# src header\nfoo\nbar\n" }],
    });
    expect(result).toBe("# base header\n\nfoo\n# src header\nbar\n");
  });

  it("trims trailing blank lines and ensures a single trailing newline", () => {
    const result = mergeIgnoreLines({
      base: "foo\n\n\n",
      sources: [],
    });
    expect(result).toBe("foo\n");
  });

  it("trims trailing whitespace from lines before dedup", () => {
    const result = mergeIgnoreLines({
      base: "foo  \nbar\n",
      sources: [{ sourceKey: "src-a", data: "foo\nbaz\n" }],
    });
    expect(result).toBe("foo\nbar\nbaz\n");
  });

  it("handles \\r\\n line endings", () => {
    const result = mergeIgnoreLines({
      base: "foo\r\nbar\r\n",
      sources: [{ sourceKey: "src-a", data: "baz\r\nfoo\r\n" }],
    });
    expect(result).toBe("foo\nbar\nbaz\n");
  });
});
