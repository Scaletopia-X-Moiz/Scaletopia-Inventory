import { listImportClientNames } from "@/lib/data/airtable-clients";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Client names for the import wizard: Active clients in Airtable (Operations
 * base, Clients table), not the push-credential `clients` table. */
export async function GET() {
  const user = await getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return Response.json({ error: "AIRTABLE_TOKEN is not configured" }, { status: 503 });
  }
  try {
    const names = await listImportClientNames(token);
    return Response.json({ clients: names.map((name) => ({ name })) });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load clients" },
      { status: 502 },
    );
  }
}
