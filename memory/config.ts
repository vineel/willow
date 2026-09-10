function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost/willow",
  lmstudio: {
    baseUrl: process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1",
    chatModel: process.env.LMSTUDIO_CHAT_MODEL ?? "google/gemma-4-12b-qat",
    embedModel: process.env.LMSTUDIO_EMBED_MODEL ?? "nomic-embed-text-v1.5",
  },
  notesRoot: required("NOTES_ROOT"),
  port: parseInt(process.env.MEMORY_PORT ?? "8789", 10),
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY ?? "3", 10),
} as const;
