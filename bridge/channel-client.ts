export async function sendToChannel(
  port: number,
  requestId: string,
  message: string
): Promise<string> {
  const response = await fetch(`http://localhost:${port}/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, message }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      `Channel error ${response.status}: ${(body as { error?: string }).error ?? "unknown"}`
    );
  }

  const result = (await response.json()) as { request_id: string; text: string };
  return result.text;
}
