// Bucket used as a temporary relay for large CSV imports, so the browser can
// upload directly to Supabase Storage and bypass the Vercel Route Handler
// request body size cap. Objects are deleted immediately after processing.
export const IMPORT_BUCKET = "csv-imports";
