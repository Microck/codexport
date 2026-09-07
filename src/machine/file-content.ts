import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { FileContent } from "./machine-state.types.ts";

/**
 * Fill an already-open private temporary file. The caller owns flush, native
 * permissions, rename, and cleanup. No target is replaced until this returns.
 * Keep one chunk in memory even when the original file is several gigabytes.
 * Adapters keep this atomic step uninterruptible so a cancelled Effect cannot
 * start rollback while its native copy and rename are still running.
 */
export const writeFileContent = async (
  destination: FileHandle,
  content: FileContent,
): Promise<void> => {
  if (content instanceof Uint8Array) {
    await destination.writeFile(content);
    return;
  }
  const path = content.file;
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("file source must be an absolute path without NUL bytes");
  }
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await source.stat();
    const visible = await lstat(path);
    if (!opened.isFile() || !visible.isFile()
      || opened.dev !== visible.dev || opened.ino !== visible.ino) {
      throw new Error(`file source is not a stable regular file: ${path}`);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > opened.size) throw new Error(`file source changed during copy: ${path}`);
      hash.update(chunk.subarray(0, bytesRead));
      // FileHandle.write may complete only part of a chunk.
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destination.write(chunk, offset, bytesRead - offset, null);
        if (bytesWritten === 0) throw new Error(`file copy made no write progress: ${path}`);
        offset += bytesWritten;
      }
    }
    const final = await source.stat();
    const current = await lstat(path);
    if (!current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino
      || total !== opened.size || final.size !== opened.size
      || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
      throw new Error(`file source changed during copy: ${path}`);
    }
    if (hash.digest("hex") !== content.digest) {
      throw new Error(`file source digest mismatch: ${path}`);
    }
  } finally {
    await source.close();
  }
};
