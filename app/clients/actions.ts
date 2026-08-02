"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOrDev } from "@/lib/auth/dal";
import {
  createClient,
  updateClientCredentials,
  type UpdateClientCredentialsInput,
} from "@/lib/data/clients";
import { logActivity } from "@/lib/activity/log";

export type ClientCredentialField = keyof UpdateClientCredentialsInput;

const EDITABLE_FIELDS: ClientCredentialField[] = [
  "ghlApiKey",
  "ghlLocationId",
  "emailbisonApiKey",
  "emailbisonWorkspaceId",
  "isActive",
];

export interface UpdateClientFieldState {
  error?: string;
}

export interface CreateClientState {
  error?: string;
  success?: boolean;
}

const MAX_NAME = 200;
const SLUG_PATTERN = /^[a-z0-9_]+$/;

/** Derives a `slug`-column-safe key from a client name: lowercase,
 * non-alphanumeric runs collapsed to a single underscore, edges trimmed.
 * Matches the `<CLIENT>` portion of the GHL_<CLIENT>_API_KEY env-var
 * convention the `slug` column was designed around (see lib/data/clients.sql). */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Creates a new client row. `slug` defaults to a normalized form of `name`
 * when left blank; either way it must be unique, which the DB enforces —
 * a 23505 violation is surfaced as a friendly error instead of a raw 500. */
export async function createClientAction(
  _prev: CreateClientState | undefined,
  formData: FormData
): Promise<CreateClientState> {
  const admin = await requireAdminOrDev();

  const name = String(formData.get("name") ?? "").trim();
  const rawSlug = String(formData.get("slug") ?? "").trim();

  if (!name) return { error: "Name is required." };
  if (name.length > MAX_NAME) return { error: "Name is too long." };

  const slug = slugify(rawSlug || name);
  if (!slug) return { error: "Couldn't derive a slug from that name — enter one manually." };
  if (!SLUG_PATTERN.test(slug)) {
    return { error: "Slug can only contain lowercase letters, numbers, and underscores." };
  }

  try {
    const client = await createClient({ slug, name });
    await logActivity("client.create", { clientId: client.id, slug: client.slug }, admin);
    revalidatePath("/clients");
    return { success: true };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      return { error: `A client with slug "${slug}" already exists.` };
    }
    return { error: err instanceof Error ? err.message : "Failed to create client." };
  }
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
