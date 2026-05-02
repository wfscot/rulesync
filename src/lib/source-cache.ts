import { createHash } from "node:crypto";
import { join, posix } from "node:path";

import { RULESYNC_SOURCES_RELATIVE_DIR_PATH } from "../constants/rulesync-paths.js";
import { ALL_GIT_PROVIDERS } from "../types/git-provider.js";
import {
  checkPathTraversal,
  directoryExists,
  ensureDir,
  findFilesByGlobs,
  readFileBuffer,
  removeDirectory,
  toPosixPath,
  writeFileBuffer,
} from "../utils/file.js";
import type { Logger } from "../utils/logger.js";
import { parseSource } from "./source-parser.js";

const ROOT_PATH_SEGMENT = "_root_";
const RAW_URL_SEGMENT_PREFIX = "_raw_";
const RAW_URL_HASH_BYTES = 12;

/**
 * A cache slot identifies a unique fetched (source, ref, path) tuple.
 * The cache is laid out at:
 *   .rulesync/.sources/<source-segment>/<resolved-sha>/<path-segment>/...
 *
 * The slot is a directory that contains the fetched files at their original
 * relative paths within `<path>` of the source repo.
 */
export type SourceSlotKey = {
  /** Filesystem-safe segment derived from the source URL/spec. */
  sourceSegment: string;
  /** 40-character hex commit SHA. */
  resolvedSha: string;
  /** Filesystem-safe segment derived from the source entry's `path`. */
  pathSegment: string;
};

/**
 * Compute a stable, filesystem-safe slot key from a source URL/spec, a
 * resolved commit SHA, and the source entry's `path`.
 *
 * For known Git providers (github/gitlab) the source segment is human-readable
 * (`<provider>_<owner>_<repo>`). For arbitrary URLs (e.g. Azure DevOps,
 * self-hosted GitLab) the segment falls back to a short content hash with a
 * `_raw_` prefix to make it visually distinct in `ls` output.
 */
export function computeSourceSlotKey(params: {
  sourceUrl: string;
  resolvedSha: string;
  path?: string;
}): SourceSlotKey {
  const { sourceUrl, resolvedSha, path } = params;
  return {
    sourceSegment: encodeSourceSegment(sourceUrl),
    resolvedSha,
    pathSegment: encodePathSegment(path ?? ""),
  };
}

/**
 * Get the absolute path to a cache slot for a given project.
 */
export function getSourceSlotPath(params: {
  projectRoot: string;
  slotKey: SourceSlotKey;
}): string {
  const { projectRoot, slotKey } = params;
  return join(
    projectRoot,
    RULESYNC_SOURCES_RELATIVE_DIR_PATH,
    slotKey.sourceSegment,
    slotKey.resolvedSha,
    slotKey.pathSegment,
  );
}

export async function sourceSlotExists(params: {
  projectRoot: string;
  slotKey: SourceSlotKey;
}): Promise<boolean> {
  return directoryExists(getSourceSlotPath(params));
}

/**
 * Files to write into a cache slot. Paths are relative to the slot directory.
 */
export type SlotFile = {
  relativePath: string;
  content: Buffer;
};

/**
 * Write a set of files into a cache slot. The slot directory is created if it
 * does not already exist. Paths are validated against traversal.
 *
 * Note: this writes files with default permissions. Executable-bit preservation
 * is handled by callers when needed (separate workstream).
 */
export async function writeSourceSlotFiles(params: {
  projectRoot: string;
  slotKey: SourceSlotKey;
  files: SlotFile[];
}): Promise<void> {
  const slotPath = getSourceSlotPath(params);
  await ensureDir(slotPath);
  for (const file of params.files) {
    checkPathTraversal({ relativePath: file.relativePath, intendedRootDir: slotPath });
    const absolutePath = join(slotPath, file.relativePath);
    await writeFileBuffer(absolutePath, file.content);
  }
}

/**
 * Read all files in a cache slot, returning their relative paths and contents.
 * Returns an empty array if the slot does not exist.
 */
export async function readSourceSlotFiles(params: {
  projectRoot: string;
  slotKey: SourceSlotKey;
}): Promise<SlotFile[]> {
  const slotPath = getSourceSlotPath(params);
  if (!(await directoryExists(slotPath))) {
    return [];
  }
  const filePaths = await findFilesByGlobs(join(slotPath, "**", "*"), { type: "file" });
  const result: SlotFile[] = [];
  for (const absolutePath of filePaths) {
    const relativePath = toPosixPath(absolutePath.substring(slotPath.length + 1));
    const content = await readFileBuffer(absolutePath);
    result.push({ relativePath, content });
  }
  return result;
}

/**
 * Remove a single cache slot directory.
 */
export async function removeSourceSlot(params: {
  projectRoot: string;
  slotKey: SourceSlotKey;
}): Promise<void> {
  const slotPath = getSourceSlotPath(params);
  if (await directoryExists(slotPath)) {
    await removeDirectory(slotPath);
  }
}

/**
 * Remove cache slots that are no longer referenced by any active source entry.
 * Returns the number of slots removed.
 *
 * The set of active slots is determined by the caller (typically derived from
 * the current sources list and lockfile state).
 *
 * Empty parent directories (by source segment / sha) are also removed for tidiness.
 */
export async function pruneStaleSourceSlots(params: {
  projectRoot: string;
  activeSlotKeys: SourceSlotKey[];
  logger: Logger;
}): Promise<number> {
  const { projectRoot, activeSlotKeys, logger } = params;
  const sourcesRoot = join(projectRoot, RULESYNC_SOURCES_RELATIVE_DIR_PATH);
  if (!(await directoryExists(sourcesRoot))) {
    return 0;
  }

  const activeSet = new Set(activeSlotKeys.map(serializeSlotKey));
  let removed = 0;

  // Walk three levels: <source-segment>/<sha>/<path-segment>
  const sourceSegments = await findFilesByGlobs(join(sourcesRoot, "*"), { type: "dir" });
  for (const sourceSegmentPath of sourceSegments) {
    const shaSegments = await findFilesByGlobs(join(sourceSegmentPath, "*"), { type: "dir" });
    for (const shaSegmentPath of shaSegments) {
      const pathSegments = await findFilesByGlobs(join(shaSegmentPath, "*"), { type: "dir" });
      for (const pathSegmentPath of pathSegments) {
        const slotKey = parseSlotPath({ sourcesRoot, slotPath: pathSegmentPath });
        if (slotKey && !activeSet.has(serializeSlotKey(slotKey))) {
          await removeDirectory(pathSegmentPath);
          logger.debug(`Pruned stale source cache slot: ${pathSegmentPath}`);
          removed++;
        }
      }
      // Remove now-empty sha segment dir
      const remainingPaths = await findFilesByGlobs(join(shaSegmentPath, "*"), { type: "dir" });
      if (remainingPaths.length === 0) {
        await removeDirectory(shaSegmentPath);
      }
    }
    // Remove now-empty source segment dir
    const remainingShas = await findFilesByGlobs(join(sourceSegmentPath, "*"), { type: "dir" });
    if (remainingShas.length === 0) {
      await removeDirectory(sourceSegmentPath);
    }
  }

  return removed;
}

/**
 * Encode a source URL/spec into a filesystem-safe segment.
 *
 * For known Git providers (github/gitlab) the segment is human-readable:
 *   `<provider>_<owner>_<repo>`
 *
 * For arbitrary URLs the segment is a short hash with a `_raw_` prefix.
 */
function encodeSourceSegment(sourceUrl: string): string {
  try {
    const parsed = parseSource(sourceUrl);
    if (ALL_GIT_PROVIDERS.includes(parsed.provider)) {
      return sanitizeFsSegment(`${parsed.provider}_${parsed.owner}_${parsed.repo}`);
    }
  } catch {
    // Fall through to raw-URL hashing.
  }
  const hash = createHash("sha256").update(sourceUrl).digest("hex");
  return `${RAW_URL_SEGMENT_PREFIX}${hash.substring(0, RAW_URL_HASH_BYTES * 2)}`;
}

/**
 * Encode a relative path into a filesystem-safe single-segment string.
 * Empty / undefined becomes `_root_`. Forward slashes become `__`.
 */
function encodePathSegment(path: string): string {
  if (path === "") return ROOT_PATH_SEGMENT;
  // Normalize to posix separators, then collapse to a single segment.
  const normalized = posix.normalize(toPosixPath(path)).replace(/^\/+|\/+$/g, "");
  if (normalized === "" || normalized === ".") return ROOT_PATH_SEGMENT;
  return sanitizeFsSegment(normalized.replace(/\//g, "__"));
}

/**
 * Strip characters that are unsafe across Windows/macOS/Linux filesystems.
 * Reserved chars: `/ \ : * ? " < > |` plus control characters.
 */
function sanitizeFsSegment(value: string): string {
  return value.replace(/[/\\:*?"<>|\x00-\x1f]/g, "_");
}

/**
 * Serialize a slot key to a string for use in Sets/Maps.
 */
function serializeSlotKey(key: SourceSlotKey): string {
  return `${key.sourceSegment}/${key.resolvedSha}/${key.pathSegment}`;
}

/**
 * Parse an absolute slot directory path back into its key components.
 * Returns undefined if the path does not match the expected three-level layout.
 */
function parseSlotPath(params: {
  sourcesRoot: string;
  slotPath: string;
}): SourceSlotKey | undefined {
  const { sourcesRoot, slotPath } = params;
  if (!slotPath.startsWith(sourcesRoot)) return undefined;
  const tail = slotPath.substring(sourcesRoot.length).replace(/^[/\\]+/, "");
  const segments = tail.split(/[/\\]/);
  if (segments.length !== 3) return undefined;
  const [sourceSegment, resolvedSha, pathSegment] = segments;
  if (!sourceSegment || !resolvedSha || !pathSegment) return undefined;
  return { sourceSegment, resolvedSha, pathSegment };
}
