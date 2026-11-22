/**
 * Hosted, OpenAI-compatible endpoints. Only Gemini has been exercised live by the maintainers; the others speak the same
 * protocol (use `--base-url` for any other). Keys come from the named environment variable.
 */
export const PRESETS: Record<string, { baseUrl: string; keyEnv: string }> = {
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
};
