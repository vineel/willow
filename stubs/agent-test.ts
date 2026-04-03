export {};

const BRIDGE_URL = "http://localhost:8787";

const prompt =
  Bun.argv[2] ?? "What are three interesting facts about TypeScript? Be concise.";
const multiTurn = Bun.argv[3] === "--multi";

console.log(`\nPrompt: ${prompt}`);
console.log("Sending to bridge...\n");

const response = await fetch(`${BRIDGE_URL}/agent/reason`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt }),
});

if (!response.ok) {
  const err = await response.json();
  console.error("Error:", err);
  process.exit(1);
}

const result = (await response.json()) as {
  request_id: string;
  result: string;
  session_id: string;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number };
};

console.log("Result:", result.result);
console.log(`\n--- Metadata ---`);
console.log(`Session:  ${result.session_id}`);
console.log(`Duration: ${result.duration_ms}ms`);
console.log(`Turns:    ${result.num_turns}`);
console.log(`Cost:     $${result.total_cost_usd}`);
console.log(
  `Tokens:   ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`
);

if (multiTurn) {
  console.log("\n--- Multi-turn test (--resume) ---\n");

  const followUp = await fetch(`${BRIDGE_URL}/agent/reason`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "Summarize your previous answer in one sentence.",
      session_id: result.session_id,
    }),
  });

  if (!followUp.ok) {
    const err = await followUp.json();
    console.error("Follow-up error:", err);
    process.exit(1);
  }

  const turn2 = (await followUp.json()) as typeof result;
  console.log("Turn 2:", turn2.result);
  console.log(`Duration: ${turn2.duration_ms}ms`);
  console.log(`Turns:    ${turn2.num_turns}`);
}
