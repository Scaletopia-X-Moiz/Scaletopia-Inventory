# Retest Results: 4 Aug Feedback

Checked on the live site (inventory.scaletopia.io), 6 Aug 2026

## Working

Auto-mapping and pushes
- GHL and EmailBison both show a field mapping preview before the push, with editable sources and a confirm step.
- Company name defaults to the cleaned brand name, not the raw name.
- The GHL mapping screen shows even with no filter active, and custom fields with no data are listed as "No data".
- The GHL tag supports an extra identifier, with live helper text showing the format.
- The EmailBison mapping dropdown includes the custom_data enrichment columns, not just the standard fields.
- EmailBison fields are fetched live from the EmailBison API and are accurate, with no phantom competitor fields.
- The EmailBison "Create a campaign" option is available in the campaign push flow.

Push Activity (Background Jobs)
- Pushes run in the background and complete. A running job shows a progress bar.
- The panel shows client, platform, niche, who triggered the push, and the timestamp.
- The completion summary shows Total selected, Created, Updated, and Failed as separate values. The earlier "Total selected: 0" bug is fixed and Created and Updated are no longer merged.
- Each completed push has "View Contacts" and "View Companies" buttons that open the table filtered to exactly that push.

Filters
- Filter inputs are debounced, so there is no query on every keystroke.
- "Contains" filters accept multiple values as separate chips, in the Clay style.
- The push status filter works on both People and Companies, is client specific, covers GHL and EmailBison, and the counts reconcile (not yet pushed plus already pushed equals the total).
