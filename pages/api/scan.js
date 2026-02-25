export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } },
};

// Try models in order on 429 (quota) or 404 (deprecated name)
// All support google_search grounding on the free tier
const MODELS = [
  "gemini-2.0-flash",          // primary — best reasoning, 1,500 req/day free
  "gemini-2.0-flash-lite",     // lighter 2.0 variant, higher quota
  "gemini-1.5-flash-8b",       // 4,000 req/day free — most lenient
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "GEMINI_API_KEY not set. Add it in Vercel → Settings → Environment Variables. Get a free key at aistudio.google.com/apikey",
    });
  }

  const { prompt, system } = req.body;
  const errors = [];

  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generation_config: { temperature: 0.1, max_output_tokens: 8192 },
        }),
      });

      const data = await upstream.json();

      // 429 = quota hit, 404 = model renamed/deprecated → try next
      if (upstream.status === 429 || upstream.status === 404) {
        errors.push(`${model} (${upstream.status}): ${data.error?.message ?? upstream.statusText}`);
        continue;
      }

      if (!upstream.ok) {
        return res
          .status(upstream.status)
          .json({ error: data.error?.message || JSON.stringify(data) });
      }

      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => p.text)
        .map((p) => p.text)
        .join("\n");

      return res.status(200).json({ text, model });
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
    }
  }

  // All models failed — surface a clear actionable message
  return res.status(429).json({
    error:
      "All models failed. If you see quota errors, your API key has limit:0 — " +
      "this means it was created in Google Cloud Console, not AI Studio. " +
      "Fix: go to aistudio.google.com/apikey, create a fresh key, and update GEMINI_API_KEY in Vercel. " +
      `Details: ${errors.join(" | ")}`,
  });
}
