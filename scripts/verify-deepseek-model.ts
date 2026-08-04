const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com")
  .trim()
  .replace(/\/+$/, "");
const expectedModel = (
  process.env.DEEPSEEK_RESPONSES_MODEL ?? "deepseek-v4-flash"
).trim();

if (!apiKey) {
  throw new Error("DEEPSEEK_API_KEY is required.");
}
if (!expectedModel) {
  throw new Error("DEEPSEEK_RESPONSES_MODEL is required.");
}

const timeout = AbortSignal.timeout(30_000);
const response = await fetch(`${baseUrl}/models`, {
  headers: { Authorization: `Bearer ${apiKey}` },
  signal: timeout
});

if (!response.ok) {
  throw new Error(
    `DeepSeek /models verification failed with HTTP ${response.status}.`
  );
}

const payload = (await response.json()) as unknown;
const modelIds = readModelIds(payload);
if (!modelIds.includes(expectedModel)) {
  throw new Error(
    `Configured model ${expectedModel} was not returned by DeepSeek /models.`
  );
}

console.log(`Verified DeepSeek model: ${expectedModel}`);

function readModelIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
}

export {};
