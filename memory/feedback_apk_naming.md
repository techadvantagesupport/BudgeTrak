---
name: Always name built APKs BudgeTrak.apk
description: User preference — every debug APK I build and copy to Downloads must be named BudgeTrak.apk (overwriting any previous copy). Do not use versioned names like BudgeTrak-debug-v19.apk.
type: feedback
originSessionId: a00b436a-3ced-4e78-a40e-780a8f5acff8
---
When building a debug APK for the user to sideload, always copy it to:

```
/storage/emulated/0/Download/BudgeTrak.apk
```

Never use versioned names (e.g. `BudgeTrak-debug-AiOcr-v19-T9.apk`, `BudgeTrak-debug-SavePhotos-fix.apk`). Each new build overwrites the previous — the user wants exactly one file in Downloads called `BudgeTrak.apk`.

**Why:** versioned names accumulate dozens of stale files that the user has to clean up manually. They always install the latest; older copies are never useful once superseded.

**How to apply:** in any `cp` command after `./gradlew assembleDebug`, use the fixed path above. If I spot stale `BudgeTrak-debug-*.apk` files in Downloads during a build, delete them in the same batch so the directory stays clean.
