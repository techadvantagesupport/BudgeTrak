---
name: Memory routing — project vs private
description: Auto-memory writes default to the tracked repo `memory/` via a symlink; truly personal content goes to an un-tracked `private-notes/` sibling.
type: feedback
originSessionId: a00b436a-3ced-4e78-a40e-780a8f5acff8
---

Two memory locations for this working directory, with different roles:

- `~/.claude/projects/-data-data-com-termux-files-home/memory/` is a **symlink** to `/data/data/com.termux/files/home/dailyBudget/memory/`. Writes here land in the app repo, get committed and pushed as normal. This is the default destination for auto-memory — it captures project-specific feedback, design decisions, build gotchas, feature preferences, and similar content a new device or new collaborator should see.

- `~/.claude/projects/-data-data-com-termux-files-home/private-notes/` is an **ordinary directory** that is NOT tracked by git and NOT pushed anywhere. Writes here stay local. This is the destination for genuinely personal content that shouldn't end up on GitHub — health notes, personal-life context, finances outside BudgeTrak, names of family members in personal context, anything the user would feel uncomfortable seeing in a public (even private) repo.

**How to apply:**
- Default auto-memory writes to `memory/` (the symlink). Safe for project stuff.
- If the content feels personal in nature, write to `private-notes/` instead. When unsure, prefer `private-notes/` over exposing something to the repo.
- `MEMORY.md` in the tracked `memory/` dir is the project-visible index. `private-notes/` has its own `MEMORY.md` if needed; never index private notes from the tracked location.
- When the user explicitly says "remember that..." and the content is clearly project-adjacent (e.g. "I prefer Home Supplies for pet items"), write to `memory/`. When it's personal ("my dog's name is X", "I have a doctor's appointment Tuesday"), write to `private-notes/`.

**Why:**
Phone loss should preserve project knowledge across a reinstall (tracked repo handles this), without leaking personal context into commits someone else might read. The symlink gives the durability; the separate private dir gives the privacy.
