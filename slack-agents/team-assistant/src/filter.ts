const MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 5_000;
const SKIP_BELOW = 0.2;

const QUESTION = `You decide whether the latest message in a Slack thread is meant for the AI assistant in that thread.
Answer with only a number from 0 to 100: how likely it is that the author expects the assistant to respond.
Follow-ups, corrections and questions to the assistant score high. Messages people send each other score low.`;

export async function isMeantForAgent(apiKey: string | undefined, transcript: string): Promise<boolean> {
  if (!apiKey) return true;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 5,
        system: QUESTION,
        messages: [{ role: "user", content: transcript }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
    const { content } = (await res.json()) as { content?: { type: string; text?: string }[] };
    const score = Number(content?.find((block) => block.type === "text")?.text?.match(/\d+/)?.[0]);
    if (!Number.isFinite(score) || score < 0 || score > 100) return true;
    return score / 100 >= SKIP_BELOW;
  } catch (err) {
    console.error("The reply check failed, so the agent will see the reply:", (err as Error).message);
    return true;
  }
}
