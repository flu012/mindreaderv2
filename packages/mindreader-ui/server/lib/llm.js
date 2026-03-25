/**
 * Shared LLM calling utility — Node.js fetch, OpenAI-compatible.
 * Used by preprocessor. Does NOT replace existing Python inline LLM scripts.
 */

/**
 * Call an OpenAI-compatible chat completions API.
 *
 * @param {object} opts
 * @param {string} opts.prompt - User message content
 * @param {object} opts.config - Must have llmApiKey, llmBaseUrl, llmModel
 * @param {boolean} [opts.jsonMode=false] - If true, request JSON response format
 * @param {number} [opts.timeoutMs=10000] - Timeout in ms
 * @param {string} [opts.systemPrompt] - Optional system message
 * @returns {Promise<object|string>} Parsed JSON (if jsonMode) or text
 */
export async function callLLM({ prompt, config, jsonMode = false, timeoutMs = 10000, systemPrompt }) {
  const baseUrl = (config.llmBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const isDashscope = baseUrl.includes("dashscope");
  const model = config.llmModel || "gpt-4o-mini";

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, temperature: 0.1, max_tokens: 2000 };
  if (jsonMode) body.response_format = { type: "json_object" };
  if (isDashscope) body.enable_thinking = false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("LLM returned empty content");

    if (jsonMode) {
      return JSON.parse(content);
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
