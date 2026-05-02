import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RULESYNC_SOURCES_RELATIVE_DIR_PATH } from "../constants/rulesync-paths.js";
import { createMockLogger } from "../test-utils/mock-logger.js";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import {
  directoryExists,
  ensureDir,
  fileExists,
  readFileContent,
  writeFileContent,
} from "../utils/file.js";
import {
  computeSourceSlotKey,
  getSourceSlotPath,
  pruneStaleSourceSlots,
  readSourceSlotFiles,
  removeSourceSlot,
  sourceSlotExists,
  writeSourceSlotFiles,
} from "./source-cache.js";

const logger = createMockLogger();

const VALID_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("source-cache", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
    vi.clearAllMocks();
  });

  describe("computeSourceSlotKey", () => {
    it("encodes a github shorthand source as <provider>_<owner>_<repo>", () => {
      const key = computeSourceSlotKey({
        sourceUrl: "dyoshikawa/rulesync",
        resolvedSha: VALID_SHA,
      });
      expect(key.sourceSegment).toBe("github_dyoshikawa_rulesync");
      expect(key.resolvedSha).toBe(VALID_SHA);
      expect(key.pathSegment).toBe("_root_");
    });

    it("encodes a github URL the same as the shorthand form", () => {
      const a = computeSourceSlotKey({
        sourceUrl: "https://github.com/dyoshikawa/rulesync",
        resolvedSha: VALID_SHA,
      });
      const b = computeSourceSlotKey({
        sourceUrl: "github:dyoshikawa/rulesync",
        resolvedSha: VALID_SHA,
      });
      const c = computeSourceSlotKey({
        sourceUrl: "dyoshikawa/rulesync",
        resolvedSha: VALID_SHA,
      });
      expect(a.sourceSegment).toBe(b.sourceSegment);
      expect(b.sourceSegment).toBe(c.sourceSegment);
    });

    it("encodes a gitlab source distinctly from github", () => {
      const githubKey = computeSourceSlotKey({
        sourceUrl: "github:owner/repo",
        resolvedSha: VALID_SHA,
      });
      const gitlabKey = computeSourceSlotKey({
        sourceUrl: "gitlab:owner/repo",
        resolvedSha: VALID_SHA,
      });
      expect(githubKey.sourceSegment).not.toBe(gitlabKey.sourceSegment);
      expect(githubKey.sourceSegment.startsWith("github_")).toBe(true);
      expect(gitlabKey.sourceSegment.startsWith("gitlab_")).toBe(true);
    });

    it("falls back to a hashed segment for unknown providers", () => {
      const key = computeSourceSlotKey({
        sourceUrl: "https://dev.azure.com/org/proj/_git/repo",
        resolvedSha: VALID_SHA,
      });
      expect(key.sourceSegment.startsWith("_raw_")).toBe(true);
      expect(key.sourceSegment.length).toBeGreaterThan(5);
    });

    it("encodes the path component and uses _root_ for empty/missing path", () => {
      const empty = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
      });
      const root = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "",
      });
      const dot = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: ".",
      });
      expect(empty.pathSegment).toBe("_root_");
      expect(root.pathSegment).toBe("_root_");
      expect(dot.pathSegment).toBe("_root_");
    });

    it("encodes a nested path by replacing slashes with double-underscores", () => {
      const key = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "kit/skills",
      });
      expect(key.pathSegment).toBe("kit__skills");
    });

    it("strips leading and trailing slashes in the path", () => {
      const key = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "/kit/skills/",
      });
      expect(key.pathSegment).toBe("kit__skills");
    });
  });

  describe("getSourceSlotPath", () => {
    it("returns the absolute slot path under .rulesync/.sources", () => {
      const slotKey = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "skills",
      });
      const slotPath = getSourceSlotPath({ projectRoot: testDir, slotKey });
      expect(slotPath).toBe(
        join(
          testDir,
          RULESYNC_SOURCES_RELATIVE_DIR_PATH,
          slotKey.sourceSegment,
          slotKey.resolvedSha,
          slotKey.pathSegment,
        ),
      );
    });
  });

  describe("writeSourceSlotFiles + readSourceSlotFiles", () => {
    it("round-trips a set of files written into a slot", async () => {
      const slotKey = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey,
        files: [
          { relativePath: "skills/foo/SKILL.md", content: Buffer.from("hello") },
          { relativePath: "skills/foo/scripts/run.sh", content: Buffer.from("#!/bin/bash\n") },
          { relativePath: "commands/bar.md", content: Buffer.from("# bar") },
        ],
      });
      const files = await readSourceSlotFiles({ projectRoot: testDir, slotKey });
      const map = new Map(files.map((f) => [f.relativePath, f.content.toString("utf-8")]));
      expect(map.get("skills/foo/SKILL.md")).toBe("hello");
      expect(map.get("skills/foo/scripts/run.sh")).toBe("#!/bin/bash\n");
      expect(map.get("commands/bar.md")).toBe("# bar");
    });

    it("returns an empty array when the slot does not exist", async () => {
      const slotKey = computeSourceSlotKey({
        sourceUrl: "owner/missing",
        resolvedSha: VALID_SHA,
      });
      const files = await readSourceSlotFiles({ projectRoot: testDir, slotKey });
      expect(files).toEqual([]);
    });

    it("rejects path traversal in relative paths", async () => {
      const slotKey = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
      });
      await expect(
        writeSourceSlotFiles({
          projectRoot: testDir,
          slotKey,
          files: [{ relativePath: "../escaped.txt", content: Buffer.from("nope") }],
        }),
      ).rejects.toThrow(/Path traversal/);
    });
  });

  describe("sourceSlotExists", () => {
    it("returns false before any write and true after", async () => {
      const slotKey = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
      });
      expect(await sourceSlotExists({ projectRoot: testDir, slotKey })).toBe(false);
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey,
        files: [{ relativePath: "x.md", content: Buffer.from("x") }],
      });
      expect(await sourceSlotExists({ projectRoot: testDir, slotKey })).toBe(true);
    });
  });

  describe("removeSourceSlot", () => {
    it("removes a single slot without affecting siblings", async () => {
      const slotA = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "a",
      });
      const slotB = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "b",
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: slotA,
        files: [{ relativePath: "x.md", content: Buffer.from("a") }],
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: slotB,
        files: [{ relativePath: "x.md", content: Buffer.from("b") }],
      });
      await removeSourceSlot({ projectRoot: testDir, slotKey: slotA });
      expect(await sourceSlotExists({ projectRoot: testDir, slotKey: slotA })).toBe(false);
      expect(await sourceSlotExists({ projectRoot: testDir, slotKey: slotB })).toBe(true);
    });

    it("is a no-op when the slot does not exist", async () => {
      const slotKey = computeSourceSlotKey({
        sourceUrl: "owner/missing",
        resolvedSha: VALID_SHA,
      });
      await expect(removeSourceSlot({ projectRoot: testDir, slotKey })).resolves.toBeUndefined();
    });
  });

  describe("pruneStaleSourceSlots", () => {
    it("removes only slots not in the active set", async () => {
      const active = computeSourceSlotKey({
        sourceUrl: "owner/active",
        resolvedSha: VALID_SHA,
      });
      const stale = computeSourceSlotKey({
        sourceUrl: "owner/stale",
        resolvedSha: OTHER_SHA,
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: active,
        files: [{ relativePath: "x.md", content: Buffer.from("a") }],
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: stale,
        files: [{ relativePath: "x.md", content: Buffer.from("s") }],
      });

      const removed = await pruneStaleSourceSlots({
        projectRoot: testDir,
        activeSlotKeys: [active],
        logger,
      });
      expect(removed).toBe(1);
      expect(await sourceSlotExists({ projectRoot: testDir, slotKey: active })).toBe(true);
      expect(await sourceSlotExists({ projectRoot: testDir, slotKey: stale })).toBe(false);
    });

    it("removes stale sha-level dirs of an active source", async () => {
      const oldSlot = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
      });
      const newSlot = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: OTHER_SHA,
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: oldSlot,
        files: [{ relativePath: "x.md", content: Buffer.from("old") }],
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: newSlot,
        files: [{ relativePath: "x.md", content: Buffer.from("new") }],
      });

      const removed = await pruneStaleSourceSlots({
        projectRoot: testDir,
        activeSlotKeys: [newSlot],
        logger,
      });
      expect(removed).toBe(1);
      expect(await sourceSlotExists({ projectRoot: testDir, slotKey: oldSlot })).toBe(false);
      expect(await sourceSlotExists({ projectRoot: testDir, slotKey: newSlot })).toBe(true);
    });

    it("returns 0 when the .sources directory does not exist", async () => {
      const removed = await pruneStaleSourceSlots({
        projectRoot: testDir,
        activeSlotKeys: [],
        logger,
      });
      expect(removed).toBe(0);
    });

    it("removes empty parent directories after pruning", async () => {
      const slot = computeSourceSlotKey({
        sourceUrl: "owner/onlychild",
        resolvedSha: VALID_SHA,
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: slot,
        files: [{ relativePath: "x.md", content: Buffer.from("x") }],
      });
      await pruneStaleSourceSlots({ projectRoot: testDir, activeSlotKeys: [], logger });
      const sourceDir = join(testDir, RULESYNC_SOURCES_RELATIVE_DIR_PATH, slot.sourceSegment);
      expect(await directoryExists(sourceDir)).toBe(false);
    });

    it("preserves non-empty parent directories when only some slots are pruned", async () => {
      const keep = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "keep",
      });
      const drop = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "drop",
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: keep,
        files: [{ relativePath: "x.md", content: Buffer.from("k") }],
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey: drop,
        files: [{ relativePath: "x.md", content: Buffer.from("d") }],
      });
      const removed = await pruneStaleSourceSlots({
        projectRoot: testDir,
        activeSlotKeys: [keep],
        logger,
      });
      expect(removed).toBe(1);
      const shaDir = join(
        testDir,
        RULESYNC_SOURCES_RELATIVE_DIR_PATH,
        keep.sourceSegment,
        keep.resolvedSha,
      );
      expect(await directoryExists(shaDir)).toBe(true);
    });

    it("ignores unrecognized layouts under .sources without crashing", async () => {
      const sourcesRoot = join(testDir, RULESYNC_SOURCES_RELATIVE_DIR_PATH);
      await ensureDir(sourcesRoot);
      // Stray file at the root, and a stray two-level layout.
      await writeFileContent(join(sourcesRoot, "stray.txt"), "x");
      await ensureDir(join(sourcesRoot, "halfformed", "abc"));
      await writeFileContent(join(sourcesRoot, "halfformed", "abc", "y.txt"), "y");

      const removed = await pruneStaleSourceSlots({
        projectRoot: testDir,
        activeSlotKeys: [],
        logger,
      });
      // No three-level slots existed, so nothing to prune.
      expect(removed).toBe(0);
      expect(await fileExists(join(sourcesRoot, "stray.txt"))).toBe(true);
    });
  });

  describe("backward-compat: sources with the same (repo, ref, path) collide intentionally", () => {
    it("two source entries pointing at the same (repo, ref, path) write to the same slot", async () => {
      const slotKey = computeSourceSlotKey({
        sourceUrl: "owner/repo",
        resolvedSha: VALID_SHA,
        path: "skills",
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey,
        files: [{ relativePath: "x.md", content: Buffer.from("first") }],
      });
      await writeSourceSlotFiles({
        projectRoot: testDir,
        slotKey,
        files: [{ relativePath: "x.md", content: Buffer.from("second") }],
      });
      const slotPath = getSourceSlotPath({ projectRoot: testDir, slotKey });
      const content = await readFileContent(join(slotPath, "x.md"));
      expect(content).toBe("second");
    });
  });
});
