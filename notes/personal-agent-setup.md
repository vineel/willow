# Personal Agent Session Setup

Plan for a long-lived Claude Code session that acts as a personal agent, accessible remotely from phone or other Mac.

---

## Requirements

- Profile data (`notes/vineel-profile.md`) always in context, even after `/clear`
- Remote access from phone and other Mac
- Support for custom skills and MCP servers

---

## Approach

### 1. Profile Always in Context

Inline the profile directly into `CLAUDE.md` (~130 lines). This guarantees it's always loaded — CLAUDE.md is reloaded on every context reset, so `/clear` doesn't lose the profile.

### 2. Persistent tmux Session

A launcher script (`agent.sh`) that creates or reattaches a named tmux session running Claude Code:

```bash
#!/bin/bash
SESSION="willow-agent"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux attach -t "$SESSION"
else
  tmux new-session -s "$SESSION" -c /Users/vineel/aidev/willow \
    "claude"
fi
```

### 3. Remote Access

- SSH into Mac Mini via Tailscale from phone (Blink Shell / Termius) or other Mac
- Attach to session: `tmux attach -t willow-agent`

### 4. Skills & MCP Servers

Create `.claude/settings.json` at the project level to register:
- MCP servers (custom tools the agent can call)
- Custom skills (slash commands)

Skeleton to be filled in as servers/skills are built.

---

## Open Questions

- Should the tmux session auto-restart Claude Code on exit?
- Which MCP servers / skills to wire in first?
