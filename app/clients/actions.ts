"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOrDev } from "@/lib/auth/dal";
import { updateClientCredentials, type UpdateClientCredentialsInput } from "@/lib/data/clients";
import { logActivity } from "@/lib/activity/log";

export type ClientCredentialField = keyof UpdateClientCredentialsInput;

const EDITABLE_FIELDS: ClientCredentialField[] = ["ghlApiKey", "ghlLocationId", "isActive"];

export interface UpdateClientFieldState {
  error?: string;
}

/** Updates a single credential field on a client. Text fields are trimmed and
 * stored as null when empty. Never logs the field's value — credentials
 * shouldn't end up in the activity log. */
export async function updateClientField(
  clientId: string,
  field: ClientCredentialField,
  value: string | boolean
): Promise<UpdateClientFieldState> {
  const admin = await requireAdminOrDev();

  if (!EDITABLE_FIELDS.includes(field)) {
    return { error: "Unknown field." };
  }

  let input: UpdateClientCredentialsInput;
  if (field === "isActive") {
    input = { isActive: Boolean(value) };
  } else {
    const trimmed = typeof value === "string" ? value.trim() : "";
    input = { [field]: trimmed === "" ? null : trimmed };
  }

  try {
    await updateClientCredentials(clientId, input);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to save." };
  }

  await logActivity("client.credentials_update", { clientId, field }, admin);
  revalidatePath("/clients");
  return {};
}
