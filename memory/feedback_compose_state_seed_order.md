---
name: Compose state-seeding order and LaunchedEffect cancellation
description: Two related Compose gotchas hit during OCR share-intent v0. When a dialog's local state is seeded from a VM field via remember { mutableStateOf(field) }, the VM field MUST be set before the dialog-visibility flag, or remember captures null. And any long-running work kicked off from a LaunchedEffect must not mutate the effect's own keys, or the coroutine is cancelled mid-flight — hoist that work into viewModelScope.
type: feedback
---

Two related Compose gotchas hit while wiring OCR share-intent v0. Both produced the same symptom: paid users opened the Add Expense dialog but the shared receipt photo did not appear in slot 1.

## Rule 1 — Seed VM fields before opening the dialog

When a dialog's internal state is seeded from a VM field via `remember { mutableStateOf(field) }`, the VM field MUST already hold its final value *before* the dialog-visibility flag flips to true. `remember` only runs its lambda on first composition — if the field is still null at that moment, the dialog captures null permanently, and later VM updates are ignored.

**How to apply:** In any VM handler that opens a dialog and pre-populates it, always set the seed field(s) first, then set the visibility flag last. Example (correct):

```kotlin
pendingSharedReceiptId = receiptId  // seed
dashboardShowAddExpense = true      // open
```

Not:

```kotlin
dashboardShowAddExpense = true      // opens with null seed
pendingSharedReceiptId = receiptId  // too late — remember already captured null
```

**Why:** Dialog body has `var addModeReceiptId1 by remember { mutableStateOf<String?>(initialReceiptId1) }`. `remember` keys on the composable's identity, not on the parameter, so a later recomposition with a different `initialReceiptId1` does not replace the cached state.

## Rule 2 — Don't do long work inside a LaunchedEffect whose own keys you mutate

A LaunchedEffect keyed on a state value cancels its coroutine the moment that key changes. If the first thing the coroutine does is clear the trigger (e.g., `pendingSharedImageUri = null` to prevent reprocessing), recomposition fires and the coroutine is cancelled at its next suspension point. Any `withContext`, `delay`, or suspending I/O call after that point throws CancellationException silently.

**How to apply:** Move the long work into `viewModelScope.launch { ... }` (or another lifecycle-scoped scope). The LaunchedEffect's job becomes just "kick off the handler" — it finishes immediately and its own cancellation no longer matters:

```kotlin
// MainActivity
val pending = vm.pendingSharedImageUri
LaunchedEffect(pending) {
    if (pending != null) vm.consumePendingSharedImage(canAttachPhotos = ...)
}

// MainViewModel
fun consumePendingSharedImage(canAttachPhotos: Boolean) {
    val uri = pendingSharedImageUri ?: return
    pendingSharedImageUri = null
    viewModelScope.launch {
        // ...suspending work survives recomposition...
    }
}
```

**Why:** A VM-scoped coroutine outlives recomposition. The LaunchedEffect is only a trigger; it doesn't need to own the work.

## When these bite together

The OCR share-intent handler hit both at once: it was a `suspend fun` called directly from the LaunchedEffect, cleared its own trigger at the top, then did `withContext(Dispatchers.IO) { processAndSavePhoto(...) }`. Cancellation killed the processing silently (no exception surfaced to the log in release). The dialog opened first anyway because `dashboardShowAddExpense = true` ran before the suspension point — giving the appearance that "the photo just isn't showing up," which is also a Rule 1 violation. Fixing both independently is necessary; fixing only one leaves the symptom.
