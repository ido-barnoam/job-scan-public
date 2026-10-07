import { ROLE_STATUSES, setStatus, type RoleStatus } from "../../../lib/status";

export const dynamic = "force-dynamic";

// Saves a position's role status from the report page. Same secret as the report link.
// Body: { key: string, status: "new" | "cv_sent" | "not_relevant" }
export async function POST(req: Request) {
  const token = process.env.REPORT_TOKEN;
  if (!token || req.headers.get("x-report-token") !== token) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.slice(0, 1000) : "";
  const status = body?.status as RoleStatus;
  if (!key || !ROLE_STATUSES.includes(status)) return Response.json({ error: "Need key and a valid status" }, { status: 400 });

  await setStatus(key, status);
  return Response.json({ key, status });
}
