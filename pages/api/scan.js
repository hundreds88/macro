export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } },
};

const MODEL = "compound-beta-mini"; // lighter compound model, higher free-tier quota

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "GROQ_API_KEY not set. Add it in Vercel → Settings → Environment Variables. Get a free key at console.groq.com",
    });
  }

  const { prompt, system } = req.body;

  const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  const data = await upstream.json();

  if (!upstream.ok) {
    return res
      .status(upstream.status)
      .json({ error: data.error?.message || JSON.stringify(data) });
  }

  const text = data.choices?.[0]?.message?.content ?? "";

  return res.status(200).json({ text, model: MODEL });
}
