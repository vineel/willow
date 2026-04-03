export {};

const BRIDGE_URL = "http://localhost:8787";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function write(text: string) {
  Bun.write(Bun.stdout, encoder.encode(text));
}

function dim(text: string) {
  return `\x1b[2m${text}\x1b[0m`;
}

async function sendChat(message: string): Promise<void> {
  try {
    const response = await fetch(`${BRIDGE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    const body = (await response.json()) as {
      text?: string;
      error?: string;
      request_id?: string;
      session_id?: string;
    };

    if (!response.ok) {
      console.error(`Error (${response.status}): ${body.error}`);
      return;
    }

    console.log(`\nwillow> ${body.text}`);
    console.log(dim(`  [session: ${body.session_id}, request: ${body.request_id}]`));
  } catch (err) {
    console.error(
      `Connection error: ${err instanceof Error ? err.message : err}`
    );
  }
}

async function getHealth(): Promise<void> {
  try {
    const response = await fetch(`${BRIDGE_URL}/health`);
    const body = await response.json();
    console.log(JSON.stringify(body, null, 2));
  } catch (err) {
    console.error(
      `Health check failed: ${err instanceof Error ? err.message : err}`
    );
  }
}

// --- REPL ---

console.log("Willow Chat CLI");
console.log(dim("Type a message to chat. Commands: /status, /quit\n"));

const reader = Bun.stdin.stream().getReader();
let buffer = "";

write("you> ");

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value);

  // Process complete lines
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) {
      write("you> ");
      continue;
    }

    if (line === "/quit") {
      console.log("Bye!");
      process.exit(0);
    }

    if (line === "/status") {
      await getHealth();
      write("\nyou> ");
      continue;
    }

    await sendChat(line);
    write("\nyou> ");
  }
}
