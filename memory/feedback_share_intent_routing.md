---
name: Share-intent routing when dialogs are open
description: How ACTION_SEND / ACTION_SEND_MULTIPLE images are routed depending on which dialog or screen is active
type: feedback
originSessionId: a00b436a-3ced-4e78-a40e-780a8f5acff8
---
When a user shares image(s) to BudgeTrak while the app is backgrounded, the
receiving behavior depends on what dialog (if any) is active when BudgeTrak
returns to foreground.

**Why:** Before 2026-04-19, sharing to BudgeTrak with any dialog already open
just foregrounded the app and silently dropped the image — user saw nothing
happen. Worse edge cases included competing dialogs overlaying in-flight RE/IS
edits, or the CSV import dedup/match flow getting interrupted.

**How to apply (routing rules, implemented in `MainViewModel.consumePendingSharedImages`).**
Gate order matters — Gate 1 runs BEFORE Gate 2:

1. **TransactionDialog already open** → absorb. Route URIs into that dialog's
   next empty receipt slots, silently discard overflow beyond 5, fire
   `strings.settings.shareOverflowDiscarded` if any overflow occurred.
   Must be checked first because `AdAwareDialog` auto-registers the
   TransactionDialog itself in `shareBlockingDialogCount` — if the block-gate
   ran first, multi-share would bounce its second image after opening the
   dialog with the first. Transaction dialog signals its aliveness via
   `vm.transactionDialogOpenCount` (a distinct counter from the generic one).
2. **Any OTHER dialog or in-flight multi-step user process** → discard URIs
   and show `strings.settings.shareBlockedByOpenDialog`. Being on a
   non-dashboard SCREEN (Transactions list, Help pages, Settings, etc.) by
   itself is NOT a blocker; the share handler navigates to the dashboard
   before opening the Add Expense dialog in those cases.
   `anyNonTransactionDialogOpen()` checks:
   `dashShowManualDuplicateDialog`, `dashShowRecurringDialog`,
   `dashShowAmortizationDialog`, `dashShowBudgetIncomeDialog`,
   `showBackupPasswordDialog`, `showDisableBackupDialog`, `showRestoreDialog`,
   `showSavePhotosDialog`, pending-amount-update prompts,
   `csvImportInProgress` (set by TransactionsScreen while the sequential CSV
   duplicate-check phase is active), AND `shareBlockingDialogCount > 0`
   (the app-wide dialog-open counter; see last paragraph below).
3. **Nothing blocking** → set `currentScreen = "main"`, process first URI to
   a receiptId (slot 1 seed via `pendingSharedReceiptId` + `initialReceiptId1`),
   open the Add Expense dialog, let the dialog's absorber fill slots 2-5 from
   the remainder. Overflow toast same as case 1. Works whether the user was
   on the dashboard or anywhere else when the share arrived.

Free (non-paid) users still see the dialog open, but every shared photo is
discarded and the 5-second "upgrade required" toast fires (existing behavior
preserved). Shares arriving mid-TransactionDialog for a Free user clear the
URIs and toast without interrupting the dialog.

**Multi-share (`ACTION_SEND_MULTIPLE`):** also wired as of 2026-04-19. The
manifest now declares both `ACTION_SEND` (image/* + application/pdf) and
`ACTION_SEND_MULTIPLE` (image/*). `extractSharedImageUris` returns a `List<Uri>`
covering both forms.

**Absorption lives in `TransactionDialog`**, not in the VM. The VM hands a live
`pendingSharedImageUris` list to the dialog via parameter. A `LaunchedEffect`
keyed on the list size processes up to (5 - occupied) URIs per arrival, calls
`onConsumeSharedImageUris` to clear the VM list (before processing, to avoid
double-consume races), and fires `onShareOverflow` if needed. This mirrors the
existing `dialogGalleryLauncher` multi-pick pipeline so behavior stays
consistent whether the user gallery-picked or shared.

**Cross-screen dialog tracking** uses `LocalShareBlockingDialogRegistrar` (a
CompositionLocal defined in `Theme.kt`). `AdAwareDialog` auto-registers via
`DisposableEffect`, so every dialog in the app that uses the AdAware wrapper
is automatically counted in `MainViewModel.shareBlockingDialogCount` without
per-site wiring. ⚠️ Purpose-scoped: only `consumePendingSharedImages` reads
this counter. Since every dialog (pickers, confirmations, Add/Edit forms) is
registered, other consumers would fire spuriously. If a new mechanism needs a
similar "is there a dialog open?" signal, add a separate counter — don't
repurpose this one.
