import { listClientOptions } from "@/lib/data/clients";
import { FilterSlipClient } from "@/components/companies/filter-slip-client";

/** Server boundary for the Companies filter slip: fetches the client list once
 * (for the push-status filter's client picker) and hands it to the client slip
 * as a prop. Kept inside the page's Suspense so this DB read streams rather than
 * blocking the shell. */
export async function FilterSlipLoader() {
  const clientOptions = await listClientOptions();
  return <FilterSlipClient clientOptions={clientOptions} />;
}
