---
name: Surface save failures, never silently no-op
description: A save handler that closes the dialog while skipping its work is the most user-hostile bug shape we ship. Set a flag, show a toast, or prevent close — pick one, but never close-as-if-success on a no-op path.
type: feedback
---

When a Save / Confirm / Apply handler can decide "actually I'm not going to do that," it must say so. Closing the dialog on a no-op path looks identical to a successful save, so the user has no signal anything went wrong. Several beta-tester reports of "I tapped save but nothing was saved" traced back to this exact shape.

**Why:** Beta audit on 2026-04-27 found six silent-loss vectors stacked together in the transaction add/edit pipeline. Two cost users transactions outright (duplicate dialog dismiss-as-keep-existing; onResume reload race). Two more were silent UI dead-ends (multi-cat validation early-return; single-cat parse failure with no toast). One was an unguarded no-op (`onUpdateTransaction` when index < 0). One was an asymmetric guard (`addTransactionWithBudgetEffect` skipped local add but still pushed to Firestore). Each one alone looked harmless; collectively they explained almost every "transaction disappeared" report.

**How to apply:** When writing or auditing a save handler, ask three questions before letting it close the dialog:

1. **Are there any code paths that early-return without persisting?** `?: return`, guarded `if (...) { do_work }` with no `else`, asymmetric guards that protect one side effect but not another. Each one needs to either complete the save or surface a failure.
2. **Is dismiss equivalent to one of the explicit choices?** A Compose `Dialog`'s `onDismissRequest` fires on tap-outside and back. If dismiss maps to a destructive-ish choice (drop the new value, accept old), the user can hit it accidentally. Either make dismiss a no-op (require explicit choice) or make it the safest option, never the destructive one.
3. **If the save can't proceed, will the user know?** A toast, an inline error, or keeping the dialog open are all fine. Closing the dialog with no signal is never fine.

**Concrete shapes that are OK:**
- Set a `showValidation = true` flag that drives `isError`/`supportingText` in the form fields. Existing single-category branch in `TransactionDialog` does this.
- `toastState.show(S.section.specificFailureMessage, durationMs = 5000L)` — strings via the i18n system, not hardcoded.
- Make the dialog non-dismissable (`onDismissRequest = {}`) when the only safe outcomes are explicit buttons.
- Atomic guards: every side effect of a logical operation is gated by the same condition. Don't deduct the savings goal outside the same `if` that adds the transaction.

**Concrete shapes that are NOT OK:**
- `?: return` / `return@DialogPrimaryButton` with no flag set and no toast — looks like the button broke.
- `if (index >= 0) { ... }` with no `else` — silently swallows the case where the target was removed.
- `onDismissRequest = { pendingState = null }` on a duplicate-resolution dialog — tap-outside drops the new value.
- Splitting "add transaction" into "deduct SG, then if-not-already-added add it to list, unconditionally push to Firestore" — three side effects gated by zero, one, and zero conditions respectively.
