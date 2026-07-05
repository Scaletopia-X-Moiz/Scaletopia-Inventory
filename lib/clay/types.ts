/** A single entity (company or person) resolved for a Clay push. `payload` is
 * the full flat JSON object sent to the webhook — every native column plus each
 * enrichment (custom_data) key flattened to the top level, so Clay can map each
 * one to its own column. `id`/`displayName` are used for progress and failure
 * reporting, independent of the payload contents. */
export interface ClayPushRecord {
  id: string;
  displayName: string | null;
  payload: Record<string, unknown>;
}
