import { del, list, put } from "@vercel/blob";

// What you have done with each position, keyed by job key (stable across runs).
// A job with no saved status is "new".
export const ROLE_STATUSES = ["new", "cv_sent", "not_relevant"] as const;
export type RoleStatus = (typeof ROLE_STATUSES)[number];
export type StatusMap = Record<string, { status: RoleStatus; updatedAt: string }>;

// Each change writes a full snapshot under a new, unguessable URL, so a read never
// hits a stale CDN copy. Only the newest few snapshots are kept.
const PREFIX = `${process.env.VERCEL_ENV ?? "local"}/status/`;
const KEEP = 5;

async function snapshots() {
  const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
  return blobs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
}

export async function loadStatuses(): Promise<StatusMap> {
  const [latest] = await snapshots();
  if (!latest) return {};
  const res = await fetch(latest.url, { cache: "no-store" });
  return res.ok ? res.json() : {};
}

export async function setStatus(key: string, status: RoleStatus): Promise<StatusMap> {
  const all = await snapshots();
  const current: StatusMap = all[0] ? await fetch(all[0].url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})) : {};
  if (status === "new") delete current[key];
  else current[key] = { status, updatedAt: new Date().toISOString() };
  await put(`${PREFIX}${new Date().toISOString().replace(/:/g, "-")}.json`, JSON.stringify(current), {
    access: "public",
    addRandomSuffix: true,
    contentType: "application/json",
  });
  const old = all.slice(KEEP - 1).map((b) => b.url);
  if (old.length) await del(old).catch(() => {});
  return current;
}
