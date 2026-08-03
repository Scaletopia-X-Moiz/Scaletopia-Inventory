# EmailBison Push — UI reference

Screenshots of Clay's native EmailBison integration are in `screenshots/` (Create-or-update
lead panel + Import lead(s) to campaign panel, including field tooltips).

Spec source: `docs/tickets-info.pdf`, section 2 ("EmailBison Push from Inventory").

## UI container decision

Clay's panels are a **right-docked config drawer** with collapsible sections and a tooltip
on every field. Our app already has an established pattern for platform pushes — a small
centered `AlertDialog` stepper (`components/people/push-to-ghl-button.tsx`). Decision:
**keep our modal-stepper pattern, don't rebuild Clay's docked panel** — extend the same
stepper shape into a new `push-to-emailbison-button.tsx`, borrowing Clay's *field-level*
ideas (tooltips, Existing Lead Behavior, manual custom-variable row-adder, Allow parallel
sending) rather than its container chrome. Keeps EmailBison and GHL push visually
consistent with each other. See `docs/adr/0003-emailbison-two-push-actions.md` and
`CONTEXT.md` (`Push action`, `Companies-table push`) for the rest of the resolved model.

## Summary of the spec

- Follow the exact same pattern as Clay's native EmailBison integration (two enrichments:
  add lead to workspace, add lead to campaign).
- Credentials come from the `clients` table (`emailbison_api_key`, `emailbison_workspace_id`).
- EmailBison custom variables: pass the variable name as-is, no ID lookup needed (unlike GHL).
- Duplicate handling: EmailBison 422 "already taken" on email → treat as soft success, continue.
- Write back to `platform_pushes` same as GHL, with `platform = 'emailbison'`.
- Placement: "Push to EmailBison" button on both the Companies table and the People table.

Open question flagged in the doc: exact API calls need to be confirmed by walking through
Clay's built-in EmailBison enrichments (Saqlain was going to demo this on a call — not
captured in the PDF). Screenshots in this folder should fill that gap.
