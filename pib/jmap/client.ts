import type { JMAPMethodCall, JMAPResponse } from "./types";

export async function jmapRequest(
  apiUrl: string,
  token: string,
  methodCalls: JMAPMethodCall[],
  extraCapabilities?: string[]
): Promise<JMAPResponse> {
  const using = [
    "urn:ietf:params:jmap:core",
    "urn:ietf:params:jmap:mail",
    ...(extraCapabilities ?? []),
  ];

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ using, methodCalls }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`JMAP request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<JMAPResponse>;
}
