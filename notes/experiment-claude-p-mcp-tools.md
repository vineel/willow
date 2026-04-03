# Experiment: `claude -p` with MCP Tool Calls

## Question

Does Claude actually invoke MCP tools when running in print mode (`claude -p`)? And does `--resume` preserve MCP tool access across turns?

## Why This Matters

The entire scheduled agent path depends on `claude -p --mcp-config` working with real tool calls. If Claude can't call tools in print mode, agents can't access memory, web, email, etc. through MCP — and the architecture needs a fundamentally different approach for scheduled work.

## Setup

Create a minimal MCP server that exposes a tool with an observable side effect (writes to a file). This removes ambiguity about whether Claude actually called the tool vs just generated text that looks like a tool response.

### 1. Create the test MCP server

`test-mcp-server/server.ts`:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "fs";

const LOG_FILE = "/tmp/mcp-tool-calls.log";

const server = new Server(
  { name: "test-tools", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "write_note",
      description: "Write a note to the log file. Use this when asked to write or save a note.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The note content" }
        },
        required: ["content"]
      }
    },
    {
      name: "read_notes",
      description: "Read all notes from the log file. Use this when asked what notes exist.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "write_note") {
    const line = `[${new Date().toISOString()}] ${args?.content}\n`;
    appendFileSync(LOG_FILE, line);
    return { content: [{ type: "text", text: `Note written: ${args?.content}` }] };
  }

  if (name === "read_notes") {
    try {
      const { readFileSync } = await import("fs");
      const content = readFileSync(LOG_FILE, "utf-8");
      return { content: [{ type: "text", text: content || "(no notes)" }] };
    } catch {
      return { content: [{ type: "text", text: "(no notes)" }] };
    }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 2. Create the MCP config

`test-mcp-config.json`:

```json
{
  "mcpServers": {
    "test-tools": {
      "command": "bun",
      "args": ["run", "--silent", "./test-mcp-server/server.ts"]
    }
  }
}
```

### 3. Clear the log before each test

```bash
rm -f /tmp/mcp-tool-calls.log
```

## Tests

### Test A: Basic tool call in print mode

```bash
rm -f /tmp/mcp-tool-calls.log
claude -p "Use the write_note tool to write a note that says 'hello from print mode'" \
  --mcp-config test-mcp-config.json \
  --output-format json
```

**Check:**
```bash
cat /tmp/mcp-tool-calls.log
```

**Pass:** Log file contains "hello from print mode". This means Claude discovered and invoked the MCP tool.
**Fail:** Log file is empty or doesn't exist. Claude generated text but didn't actually call the tool.

### Test B: Tool call that reads data

```bash
echo "[2026-04-01] existing note" > /tmp/mcp-tool-calls.log
claude -p "Use the read_notes tool to read all notes, then tell me what they say" \
  --mcp-config test-mcp-config.json \
  --output-format json
```

**Pass:** Response includes "existing note" — Claude read real data from the tool.
**Fail:** Response is generic or hallucinated.

### Test C: `--resume` preserves MCP tool access

```bash
rm -f /tmp/mcp-tool-calls.log

# Turn 1: write a note
RESULT1=$(claude -p "Use write_note to save 'turn 1 note'" \
  --mcp-config test-mcp-config.json \
  --output-format json)

SESSION_ID=$(echo "$RESULT1" | jq -r '.session_id')
echo "Session: $SESSION_ID"
cat /tmp/mcp-tool-calls.log

# Turn 2: resume and write another note
RESULT2=$(claude -p "Use write_note to save 'turn 2 note'" \
  --mcp-config test-mcp-config.json \
  --output-format json \
  --resume "$SESSION_ID")

cat /tmp/mcp-tool-calls.log
```

**Pass:** Log file contains both "turn 1 note" and "turn 2 note".
**Fail:** Turn 2 can't find or call the tool (lazy loading issue similar to `/clear` in channels).

### Test D: Multiple tools in one prompt

```bash
rm -f /tmp/mcp-tool-calls.log
claude -p "First use write_note to save 'test note'. Then use read_notes to read all notes and tell me what's there." \
  --mcp-config test-mcp-config.json \
  --output-format json
```

**Pass:** Log file has the note AND response references it.
**Fail:** Only one tool call works, or neither.

## If It Fails

- **Tools not discovered:** Try `--allowedTools "mcp__test-tools__write_note,mcp__test-tools__read_notes"` to see if explicit permission helps.
- **Tools discovered but not called:** Check if `-p` mode suppresses tool use by default. Look for a `--tools` or `--allow-tools` flag.
- **`--resume` breaks tools:** This would mean agents are limited to single-turn reasoning, which is workable but constraining. Document the limitation.
- **Total failure:** Agents would need to get reasoning through the channel path after all, or we'd need a different mechanism (e.g., bridge constructs the prompt with pre-fetched context and doesn't rely on Claude calling tools).

## Time Estimate

~1 hour including setup and all four tests.
