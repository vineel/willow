import type { JMAPMethodCall, JMAPResponse } from "./types";

const JMAP_TIMEOUT_MS = 30_000;

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

  // Bound the whole request-plus-body-read, not just the initial fetch() —
  // a connection can hang mid-body-read (past the point AbortSignal on
  // fetch() reliably interrupts) and leave the process stuck forever with
  // no error, since there was no separate timeout on that phase. The
  // Promise.race lets the caller move on at the deadline regardless; the
  // AbortController is a best-effort attempt to also stop the underlying
  // fetch so it doesn't linger.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`JMAP request timed out after ${JMAP_TIMEOUT_MS}ms`));
    }, JMAP_TIMEOUT_MS);
  });

  const doRequest = async (): Promise<JMAPResponse> => {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ using, methodCalls }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`JMAP request failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<JMAPResponse>;
  };

  try {
    return await Promise.race([doRequest(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
