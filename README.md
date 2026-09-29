# ronbun2rakugo

arXiv論文をSF落語生成PLへ渡せる研究素材に変換する。

## MVP

**arXiv URL → PDF → TXT → 約800字日本語要約 → Generation handoff**

```
GET /api?url=https://arxiv.org/abs/2209.05161
```

JSON:

```json
{
  "schema": "ronbun2rakugo.handoff.v1",
  "arxiv_id": "2209.05161",
  "source_url": "https://arxiv.org/abs/2209.05161",
  "pdf_url": "https://arxiv.org/pdf/2209.05161.pdf",
  "language": "ja",
  "summary": "...",
  "summary_chars": 800,
  "next": "generation"
}
```

TXTだけ:

```
/api?url=https://arxiv.org/abs/2209.05161&format=txt
```

## Stack

- GitHub: source of truth
- GitHub Actions / AW: deployment and automation
- Cloudflare Workers: public API
- Cloudflare Workers AI: PDF text extraction + summary
- 外部LLM APIなし
- MVPではR2/D1なし。HTTPでGeneration PLへhandoff

## Boundary

```
research-rakugo
      │ arXiv URL
      ▼
ronbun2rakugo
      │ summary / handoff
      ▼
Generation PL
      │
      ▼
SF落語 / audio
```

## Deploy

GitHub Actions Secrets:

- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID

mainへのpushでWorkerをdeployする。

First E2E target: arXiv 2209.05161.
