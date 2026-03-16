---
name: Translation context for new strings
description: Always add TranslationContext entries when creating new English UI strings, so translators can produce accurate translations
type: feedback
---

When adding new UI strings to `EnglishStrings.kt` (and the corresponding `AppStrings.kt` data classes), always add matching translation context entries in `TranslationContext.kt`.

- Each new string key needs a context entry in the appropriate `val section = mapOf(...)` block
- Context describes meaning, usage location, and disambiguation (e.g. "save" means store data, not rescue)
- For lambda-typed strings, describe what each parameter represents
- New data classes (e.g. `BudgetCalendarStrings`) get their own `// ── Section Name ──` and `val sectionName = mapOf(...)` block
- File: `app/src/main/java/com/syncbudget/app/ui/strings/TranslationContext.kt`
