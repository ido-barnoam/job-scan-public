import { list, put } from "@vercel/blob";
import type { RunReport } from "./types";

// Each run is one immutable JSON file. Dedup history and the score cache are
// derived from earlier runs, so nothing is ever overwritten.
// Preview and production keep separate histories.
const PREFIX = `${process.env.VERCEL_ENV ?? "local"}/runs/`;

export interface RunEntry {
  id: string;
  url: string;
  uploadedAt: Date;
  size: number;
}

// Blob usage by this invocation, for the usage report. list() and put() are
// "advanced" operations; reading a blob by URL is a "simple" one (on a cache miss).
export const blobUsage = { advanced: 0, simple: 0, bytesRead: 0, bytesWritten: 0 };

export async function saveRun(r: RunReport): Promise<void> {
  const body = JSON.stringify(r);
  blobUsage.advanced++;
  blobUsage.bytesWritten += body.length;
  await put(`${PREFIX}${r.id}.json`, body, {
    access: "public",
    addRandomSuffix: true, // makes the file URL unguessable
    contentType: "application/json",
  });
}

export async function listRuns(): Promise<RunEntry[]> {
  const out: RunEntry[] = [];
  let cursor: string | undefined;
  do {
    blobUsage.advanced++;
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const id = b.pathname.slice(PREFIX.length).replace(/-[A-Za-z0-9]+\.json$/, "").replace(/\.json$/, "");
      out.push({ id, url: b.url, uploadedAt: new Date(b.uploadedAt), size: b.size });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

export async function loadRun(e: RunEntry): Promise<RunReport> {
  blobUsage.simple++;
  const res = await fetch(e.url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not read run ${e.id}: HTTP ${res.status}`);
  const text = await res.text();
  blobUsage.bytesRead += text.length;
  return JSON.parse(text);
}
