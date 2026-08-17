# Still Needs Attention (4 Aug Feedback)

Local tracking notes. Checked on the live site (inventory.scaletopia.io), 6 Aug 2026.

- Companies filter on the "categories" field still returns a server error (HTTP 503) and shows "Failed to load companies. Please refresh." The same filter on the "specialties" field works, so this is specific to the categories field. The categories condition is sent as type `text` while specialties is sent as type `list`, which looks related.

- AND/OR filter groups are partly working. Combining two separate groups with AND or OR works, but the AND/OR toggle between two conditions inside the same group does not. The toggle is visually clipped and clicking it does not change the result or the query.

- Failed pushes do not show a failure reason. The failed count is shown on the job card, but not why they failed.

- Minor: the EmailBison mapping dialog is slow to open, around 13 to 23 seconds, and makes duplicate network calls to the same endpoints.
