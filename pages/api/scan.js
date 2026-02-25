export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } },
};

// Try models in order on 429 — all support google_search grounding on free tier
const MODELS = [
  "gemini-2.0-flash",       // best reasoning; 1,500 req/day free
  "gemini-1.5-flash",       // proven stable; 1,500 req/day free
  "gemini-1.5-flash-8b",    // most lenient; 4,000 req/day free
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "GEMINI_API_KEY not set — add it in Vercel → Settings → Environment Variables" });
  }

  const { prompt, system } = req.body;

  let lastError = null;

  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let data;
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

      data = await upstream.json();

      if (upstream.status === 429) {
        // quota hit — try next model
        lastError = data.error?.message || `${model}: rate limited`;
        continue;
      }

      if (!upstream.ok) {
        return res
          .status(upstream.status)
          .json({ error: data.error?.message || JSON.stringify(data) });
      }

      // Extract text from Gemini response (skip grounding metadata parts)
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => p.text)
        .map((p) => p.text)
        .join("\n");

      return res.status(200).json({ text, model });
    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  // All models exhausted
  return res.status(429).json({
    error: `All Gemini models rate-limited. Fix: create a fresh API key at aistudio.google.com/apikey (not Google Cloud Console). Last error: ${lastError}`,
  });
}
