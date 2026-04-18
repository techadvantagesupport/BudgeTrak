---
name: BudgeTrak Legal repo location
description: Separate git repo for privacy policy, app-store copy, and legal docs. Not in the main BudgeTrak codebase — lives at its own GitHub URL and is cloned to a Downloads folder for user-visible access on Android.
type: reference
originSessionId: a00b436a-3ced-4e78-a40e-780a8f5acff8
---
The BudgeTrak legal/privacy content lives in its own repo, separate from the app code.

**Git remote**: https://github.com/techadvantagesupport/budgetrak-legal
**Primary branch**: `main` (no `dev` branch — small repo, commits go straight to main)

**Local working copy**: `/storage/emulated/0/Download/BudgeTrak Legal Files`

This is on Android external storage (scoped to Downloads) so the user can view files from the Files app. Git works here but Termux flagged it as "dubious ownership" on first access — requires this one-time setup:

```
git config --global --add safe.directory '/storage/emulated/0/Download/BudgeTrak Legal Files'
```

That's already been set for this user.

**Current files**:
- `privacy.md` — the full privacy policy. Includes the "AI-Assisted Features" section (receipt OCR + CSV categorization, added by commit `c1642ca` on 2026-04-16).
- `README.md` — minimal repo readme
- `budgetrak_logo.png`, `ic_app_icon.png` — branding assets used by the Play Store listing

**When to touch this repo**:
- Any new user-visible data practice (new analytics, new AI feature, new third-party integration) needs a matching privacy.md update before the build ships.
- Branding changes (logo, name) also live here.

**How to access**:
```
cd "/storage/emulated/0/Download/BudgeTrak Legal Files"
git status
git pull origin main          # fetch updates
# edit privacy.md ...
git add privacy.md
git commit -m "privacy: ..."
git push origin main
```

The privacy policy is linked from the app's Settings → About section and from the Google Play listing.
