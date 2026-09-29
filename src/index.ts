export interface Env {
  AI: {
    toMarkdown: (
      files: { name: string; blob: Blob },
      options?: {
        conversionOptions?: {
          output?: { format?: "markdown" | "text" };
          pdf?: { metadata?: boolean };
        };
      },
    ) => Promise<ConversionResult | ConversionResult[]>;
    run: (model: string, input: unknown) => Promise<unknown>;
  };
}

interface ConversionResult {
  id: string;
  name: string;
  format: "markdown" | "text" | "error";
  mimetype: string;
  tokens?: number;
  data?: string;
  error?: string;
}

const MODEL = "@cf/meta/llama-3.2-1b-instruct";
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_CHARS = 36_000;

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function cors() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function pdfUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.hostname !== "arxiv.org" && url.hostname !== "www.arxiv.org") return null;
    const match = url.pathname.match(/^\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/);
    if (!match) return null;
    return `https://arxiv.org/pdf/${encodeURIComponent(match[1])}.pdf`;
  } catch {
    return null;
  }
}

function arxivId(url: string): string {
  return new URL(url).pathname.split("/").pop()?.replace(/\.pdf$/, "") ?? "paper";
}

function sourceForModel(text: string): string {
  if (text.length <= MAX_SOURCE_CHARS) return text;
  const head = Math.floor(MAX_SOURCE_CHARS * 0.72);
  const tail = MAX_SOURCE_CHARS - head;
  return text.slice(0, head) + "\n\n[...middle omitted for MVP...]\n\n" + text.slice(-tail);
}

function extractModelText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (typeof r.response === "string") return r.response;
  if (typeof r.text === "string") return r.text;
  if (r.result && typeof r.result === "object") {
    const nested = r.result as Record<string, unknown>;
    if (typeof nested.response === "string") return nested.response;
    if (typeof nested.text === "string") return nested.text;
  }
  return "";
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*\`\`\`(?:text)?\s*/i, "")
    .replace(/\s*\`\`\`\s*$/i, "")
    .trim();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return cors();

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/api") {
      return json({
        name: "ronbun2rakugo",
        endpoint: "/api?url=<arxiv-url>",
        example: "/api?url=https://arxiv.org/abs/2209.05161",
      });
    }

    const sourceUrl = requestUrl.searchParams.get("url");
    if (!sourceUrl) return json({ error: "url query parameter is required" }, 400);

    const pdf = pdfUrl(sourceUrl);
    if (!pdf) {
      return json({ error: "Only arXiv /abs/ID or /pdf/ID.pdf URLs are supported" }, 400);
    }

    const upstream = await fetch(pdf, {
      headers: {
        "User-Agent": "ronbun2rakugo/0.1 (+https://github.com/bonsai/ronbun2rakugo)",
      },
    });

    if (!upstream.ok) {
      return json({ error: `arXiv PDF fetch failed: ${upstream.status}` }, 502);
    }

    const length = Number(upstream.headers.get("content-length") ?? "0");
    if (length > MAX_PDF_BYTES) return json({ error: "PDF exceeds the 20 MB MVP limit" }, 413);

    const bytes = await upstream.arrayBuffer();
    if (bytes.byteLength > MAX_PDF_BYTES) {
      return json({ error: "PDF exceeds the 20 MB MVP limit" }, 413);
    }

    const id = arxivId(pdf);
    const converted = await env.AI.toMarkdown(
      {
        name: `${id}.pdf`,
        blob: new Blob([bytes], { type: "application/pdf" }),
      },
      {
        conversionOptions: {
          output: { format: "text" },
          pdf: { metadata: false },
        },
      },
    );

    const result = Array.isArray(converted) ? converted[0] : converted;
    if (!result || result.format === "error" || !result.data) {
      return json({ error: "PDF text extraction failed", detail: result?.error ?? null }, 502);
    }

    const prompt = `あなたは研究編集者です。以下の論文本文だけを根拠に、日本語で約800字の要約を作成してください。

条件:
- 700〜900字程度
- 研究目的、方法、主要な結果、意味を含める
- 重要な数値や比較結果は残す
- 本文にない推測を追加しない
- SF落語の生成担当が素材として使えるよう、研究上の核心を明確にする
- 見出し、箇条書き、前置き、注釈は不要
- 出力は要約本文だけ

論文本文:
---
${sourceForModel(result.data)}
---`;

    const generated = await env.AI.run(MODEL, {
      prompt,
      max_tokens: 1200,
      temperature: 0.2,
    });

    const summary = stripFences(extractModelText(generated));
    if (!summary) return json({ error: "Summary generation failed" }, 502);

    const handoff = {
      schema: "ronbun2rakugo.handoff.v1",
      arxiv_id: id,
      source_url: sourceUrl,
      pdf_url: pdf,
      language: "ja",
      summary,
      summary_chars: [...summary].length,
      next: "generation",
    };

    if (requestUrl.searchParams.get("format") === "txt") {
      return new Response(summary, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return json(handoff);
  },
};
