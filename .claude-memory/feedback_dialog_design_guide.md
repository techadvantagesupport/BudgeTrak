---
name: Dialog and popup design guide
description: Standard patterns for all dialogs, popups, toasts, and buttons — colors, components, layout, keyboard/ad handling, scrollability
type: feedback
---

All dialogs must follow these standards. Never use raw Material3 `AlertDialog` or `Dialog` — always use the app's ad-aware wrappers.

**Why:** Raw Material3 dialogs don't handle the ad banner overlay, keyboard avoidance, scrollability, or the app's green-themed color system. This causes keyboards to cover inputs, buttons to be unreachable, and visual inconsistency.

**How to apply:** Whenever creating or modifying a dialog, use the components below from `Theme.kt`.

## Critical Requirements for ALL Dialogs

1. **Keyboard avoidance** — `.imePadding()` on the Surface so the keyboard pushes content up instead of covering it
2. **Scrollable body** — content must scroll when space is limited (keyboard open, long content)
3. **Button bar always visible** — footer/buttons stay pinned at the bottom, never scrolled off-screen
4. **Optimal vertical space** — dialogs should use available screen space, not be a fixed size that gets clipped
5. **PulsingScrollArrow** — show when content overflows to indicate more below

`AdAwareAlertDialog` handles all of these automatically (built into Theme.kt). For `AdAwareDialog` (custom layout), you must add `.imePadding()`, `.verticalScroll()`, and `DialogFooter` manually.

## Dialog Wrappers (never use raw Dialog/AlertDialog)

| Wrapper | Use for |
|---------|---------|
| `AdAwareAlertDialog` | Confirmations, warnings, selections, dialogs with text fields — has built-in header/footer/scroll/keyboard handling |
| `AdAwareDialog` | Complex form dialogs needing custom layout (wrap with Surface + DialogHeader + DialogFooter) |
| `AdAwareDatePickerDialog` | Date pickers |

## Dialog Styles

| Style | Header color | Button type | Use for |
|-------|-------------|-------------|---------|
| `DialogStyle.DEFAULT` | Green `#2E7D32`/`#1B5E20` | `DialogPrimaryButton` | Normal actions |
| `DialogStyle.DANGER` | Red `#B71C1C` | `DialogDangerButton` | Destructive actions (delete, leave group) |
| `DialogStyle.WARNING` | Orange `#E65100` | `DialogWarningButton` | Caution actions (reset, reassign) |

## Buttons

- **`DialogPrimaryButton`** — green filled, 500ms debounce, RoundedCornerShape(8.dp)
- **`DialogSecondaryButton`** — gray filled, same shape
- **`DialogDangerButton`** — red `#C62828` filled, 500ms debounce
- **`DialogWarningButton`** — orange `#E65100` filled, 500ms debounce
- Never use raw `TextButton` or `Button` in dialogs

## Alert Dialog Structure (built-in scroll + keyboard handling)

```kotlin
AdAwareAlertDialog(
    onDismissRequest = { ... },
    title = { Text("Title") },
    text = {
        // Content here is automatically scrollable and keyboard-aware
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Body text")
            OutlinedTextField(...)  // keyboard won't cover this
        }
    },
    style = DialogStyle.DEFAULT,
    confirmButton = { DialogPrimaryButton(onClick = { ... }) { Text("OK") } },
    dismissButton = { DialogSecondaryButton(onClick = { ... }) { Text("Cancel") } }
)
```

## Form Dialog Structure (manual scroll + keyboard handling)

```kotlin
AdAwareDialog(onDismissRequest = { ... }) {
    Surface(modifier = Modifier.fillMaxWidth(0.92f).imePadding(),
        shape = RoundedCornerShape(16.dp), tonalElevation = 6.dp) {
        Column {
            DialogHeader(title)
            val scrollState = rememberScrollState()
            Column(modifier = Modifier.weight(1f, fill=false)
                .verticalScroll(scrollState)
                .padding(horizontal=20.dp, vertical=16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // scrollable content — fields, text, etc.
            }
            DialogFooter { /* button row — always visible at bottom */ }
            PulsingScrollArrow(scrollState = scrollState)
        }
    }
}
```

## Corner Radii

- Dialog Surface: 16.dp
- Dialog Header: top corners only 16.dp
- Buttons: 8.dp
- Toast: 12.dp

## Colors (dark / light)

- Header: `#1B5E20` / `#2E7D32`
- Header text: `#E8F5E9` / White
- Footer: `#1A3A1A` / `#E8F5E9`
- Section labels: `#81C784` / `#2E7D32`

## Toast

Use `LocalAppToast.current.show(message)` — never Snackbar or Android Toast.
