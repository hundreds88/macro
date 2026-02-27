import Groq from "groq-sdk";

const PRIMARY_MODEL  = "llama-3.3-70b-versatile";
const FALLBACK_MODEL = "mixtral-8x7b-32768";

export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } },
  maxDuration: 60, // Vercel Pro only; harmless on free tier
};

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

  const { prompt, system, liveData } = req.body;

  // Prepend live market data block if provided so the LLM sees real values first
  const finalPrompt = liveData && Object.keys(liveData).length > 0
    ? `LIVE MARKET DATA (use these exact values, do not estimate):\n${JSON.stringify(liveData, null, 2)}\n\n---\n\n${prompt}`
    : prompt;

  const groq = new Groq({ apiKey });

  async function callGroq(model) {
    const completion = await groq.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: finalPrompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    });
    return completion.choices?.[0]?.message?.content ?? "";
  }

  try {
    const text = await callGroq(PRIMARY_MODEL);
    return res.status(200).json({ text, model: PRIMARY_MODEL });
  } catch (primaryErr) {
    console.error("Groq primary model error:", primaryErr);
    try {
      const text = await callGroq(FALLBACK_MODEL);
      return res.status(200).json({ text, model: FALLBACK_MODEL });
    } catch (fallbackErr) {
      console.error("Groq fallback model error:", fallbackErr);
      return res.status(500).json({ error: fallbackErr.message });
    }
  }
}
