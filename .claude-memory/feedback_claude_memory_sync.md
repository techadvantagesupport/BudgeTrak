---
name: Keep .claude-memory current
description: Always sync memory files to .claude-memory/ in project root when memories are created or updated
type: feedback
---

When creating or updating memory files, also copy them to `.claude-memory/` in the project root so they're available if the project is loaded in Claude Desktop or another Claude instance.

**Why:** The user works across multiple Claude instances (Termux CLI + Desktop). The `.claude-memory/` folder in the repo ensures any instance has access to project context.

**How to apply:** After writing to `/home/.claude/projects/.../memory/`, run:
`cp /home/.claude/projects/-data-data-com-termux-files-home-dailyBudget/memory/*.md /data/data/com.termux/files/home/dailyBudget/.claude-memory/`
Include the .claude-memory files in the next git commit.
