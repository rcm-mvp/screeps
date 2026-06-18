/**
 * Minimal Ollama chat client behind an interface so tests inject a mock and the
 * transport can be swapped (e.g. for the official `ollama` SDK) without touching
 * the decider.
 *
 * Targets the Ollama Cloud `/api/chat` endpoint by default (mode A — no local
 * daemon, API key in the Authorization header). Point `host` at
 * http://localhost:11434 for a local proxy signed into the cloud account (mode B).
 *
 * Important: K2.6 is a thinking model — reasoning may arrive in `message.thinking`
 * separately from the answer in `message.content`. We surface both; the decider
 * parses the directive from `content` only and captures `thinking` as the rationale.
 */

export interface ChatRequest {
  system: string;
  user: string;
}

export interface ChatResult {
  content: string;
  thinking?: string;
}

export interface OllamaClient {
  chat(req: ChatRequest): Promise<ChatResult>;
}

export interface HttpOllamaClientConfig {
  host: string;
  model: string;
  apiKey?: string;
}

interface OllamaChatResponse {
  message?: { content?: string; thinking?: string };
}

export class HttpOllamaClient implements OllamaClient {
  constructor(private readonly config: HttpOllamaClientConfig) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const url = `${this.config.host.replace(/\/$/, '')}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        // `format: 'json'` forces valid-JSON output. Cloud does NOT grammar-constrain
        // to a schema, so the prompt still carries the schema and we validate on receipt.
        format: 'json',
        // Surface the thinking trace so we can capture it as the decision rationale.
        think: true,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    return {
      content: data.message?.content ?? '',
      thinking: data.message?.thinking,
    };
  }
}
