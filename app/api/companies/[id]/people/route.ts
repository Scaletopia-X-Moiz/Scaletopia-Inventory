import { getPeopleByCompanyId } from "@/lib/data/people";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const people = await getPeopleByCompanyId(id);
  return Response.json({ people });
}
