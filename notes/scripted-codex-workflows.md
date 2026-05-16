# Scripted Codex Workflows

How to run Codex from a script with a fixed prompt, configured MCP servers, installed skills, and authorization from a ChatGPT account.

## Goal

Use the Codex CLI as the automation layer:

- Authenticate once with ChatGPT.
- Configure MCP servers once.
- Install project or user skills once.
- Run repeatable prompts with `codex exec`.

This is the right path when the desired behavior is "run Codex like the normal CLI, but from a script." It preserves Codex-specific behavior such as repo context, MCP tool discovery, skills, sandboxing, and approval policy.

## One-Time Setup

Install or update the Codex CLI:

```bash
npm i -g @openai/codex
```

Authenticate with the ChatGPT account:

```bash
codex login
```

For a headless machine, use device auth:

```bash
codex login --device-auth
```

Add MCP servers:

```bash
codex mcp add context7 -- npx -y @upstash/context7-mcp
```

For OAuth-backed MCP servers, log in separately:

```bash
codex mcp login <server-name>
```

Check configured MCP servers:

```bash
codex mcp list
```

## Skills

Codex discovers skills from these locations:

```text
repo/.agents/skills/<skill-name>/SKILL.md
$HOME/.agents/skills/<skill-name>/SKILL.md
/etc/codex/skills/<skill-name>/SKILL.md
```

For scripted runs, explicitly name the skill in the prompt:

```text
Use $my-skill. Run the workflow...
```

Explicit skill invocation is more reliable than relying on description matching in automation.

## Basic Script

Create a script like:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/vineel/aidev/willow"
PROMPT="Use \$my-skill. Run the planned maintenance task using the configured MCP tools. Make the smallest safe changes and summarize what changed."

codex exec \
  --cd "$REPO" \
  --sandbox workspace-write \
  --output-last-message "$REPO/.codex-last-result.md" \
  "$PROMPT"
```

Make it executable:

```bash
chmod +x ./run-codex-workflow.sh
```

Run it:

```bash
./run-codex-workflow.sh
```

## Isolated Workflow Profile

If the script needs a specific set of credentials, MCPs, and settings, use a dedicated `CODEX_HOME`.

Set it up once:

```bash
export CODEX_HOME="$HOME/.codex-my-workflow"

codex login
codex mcp add context7 -- npx -y @upstash/context7-mcp
codex mcp list
```

Then use the same `CODEX_HOME` in the script:

```bash
#!/usr/bin/env bash
set -euo pipefail

export CODEX_HOME="$HOME/.codex-my-workflow"

REPO="/Users/vineel/aidev/willow"

codex exec \
  --cd "$REPO" \
  --sandbox workspace-write \
  --output-last-message "$REPO/.codex-last-result.md" \
  'Use $my-skill. Run the workflow with the configured MCP tools.'
```

This is the cleanest way to guarantee that a scripted workflow uses exactly the intended Codex config, MCP servers, and ChatGPT-backed auth.

## Useful `codex exec` Options

```bash
codex exec [OPTIONS] [PROMPT]
```

Common options:

- `--cd <DIR>`: repo or workspace root.
- `--sandbox workspace-write`: allow edits inside the workspace.
- `--sandbox read-only`: analysis-only runs.
- `--ask-for-approval never`: do not pause for approvals; failures return to the model.
- `--output-last-message <FILE>`: write the final Codex response to a file.
- `--json`: stream events as JSONL for logging or orchestration.
- `--profile <NAME>`: use a config profile from `config.toml`.
- `--model <MODEL>`: override the model for this run.
- `--ignore-user-config`: ignore `config.toml` while still using auth from `CODEX_HOME`.

For prompt content from stdin:

```bash
codex exec --cd "$REPO" - < prompt.md
```

## Security Notes

ChatGPT-backed CLI auth stores local credentials under `CODEX_HOME`. Treat that directory as sensitive.

For local personal automation, ChatGPT auth is reasonable. For shared CI, public runners, or production automation, prefer API-key or service-account style credentials where possible, because they are easier to scope, rotate, and audit.

Avoid `--dangerously-bypass-approvals-and-sandbox` unless the process is already isolated by another sandbox, VM, or throwaway container.

## References

- Codex auth: https://developers.openai.com/codex/auth
- Non-interactive mode: https://developers.openai.com/codex/noninteractive
- MCP configuration: https://developers.openai.com/codex/mcp
- Skills: https://developers.openai.com/codex/skills
