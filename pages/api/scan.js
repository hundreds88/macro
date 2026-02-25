export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } },
};

const MODEL = "gemini-2.0-flash";

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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

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

  if (!upstream.ok) {
    return res
      .status(upstream.status)
      .json({ error: data.error?.message || JSON.stringify(data) });
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text)
    .map((p) => p.text)
    .join("\n");

  return res.status(200).json({ text, model: MODEL });
}
