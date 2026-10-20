// =============================================================================
// Marudam — AI Chatbot Route Handler (Gemini Powered)
// =============================================================================
// POST /api/chat
// Accepts: { message, language, context }
// Returns: { reply }
//
// The chatbot:
//  - Answers in the farmer's selected language
//  - Uses structured field context (never arbitrary DB access)
//  - Distinguishes MEASURED / ESTIMATED / FORECAST / RECOMMENDED
//  - Never invents sensor readings or field data
//  - Gracefully handles missing data
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') return null;
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';
  return { apiKey, model };
}

async function callGemini(apiKey: string, model: string, systemPrompt: string, message: string): Promise<string> {
  const modelsToTry = [model];
  for (const alt of ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.7-flash']) {
    if (!modelsToTry.includes(alt)) {
      modelsToTry.push(alt);
    }
  }

  let lastError: any = null;
  for (const m of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: message }],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 500,
          },
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const errMsg = errJson?.error?.message || `HTTP ${res.status}`;
        lastError = new Error(`Gemini (${m}) error: ${errMsg}`);
        if (res.status === 503 || res.status === 404) {
          console.warn(`[Marudam Chat] ${m} returned ${res.status}, trying fallback...`);
          continue;
        }
        throw lastError;
      }

      const data = await res.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (reply) return reply;
    } catch (e: any) {
      lastError = e;
      continue;
    }
  }

  throw lastError || new Error('Failed to generate response from Gemini');
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { message, language = 'English', context = {} } = body as {
    message: string;
    language: string;
    context: Record<string, unknown>;
  };

  if (!message?.trim()) {
    return NextResponse.json({ error: 'Message is required.' }, { status: 400 });
  }

  const geminiConfig = getGeminiConfig();

  if (!geminiConfig) {
    return NextResponse.json({
      reply: 'The AI assistant is not configured yet. Please set the GEMINI_API_KEY environment variable.',
    });
  }

  // ── Build system prompt ────────────────────────────────────────────────────
  const systemPrompt = `
You are Marudam, an agricultural field assistant for Indian farmers.
You answer questions about a farmer's specific field, using the structured context provided.

RULES YOU MUST ALWAYS FOLLOW:
1. Answer in ${language}. Always.
2. If the farmer writes in any language, still answer in ${language}.
3. Distinguish clearly between:
   - MEASURED data (actual sensor readings)
   - ESTIMATED data (root-zone estimate, not directly measured)
   - FORECAST data (weather prediction)
   - RECOMMENDED action (system suggestion, not a guaranteed outcome)
4. NEVER invent sensor readings, rainfall amounts, field events, or crop data.
5. If information is unavailable, say so clearly. Do not guess.
   Example: "I don't have current weather data for your area."
6. Be simple and farmer-friendly. Avoid technical jargon.
7. Keep answers concise — 2–5 sentences unless a detailed explanation is clearly needed.
8. Do not mention confidence numbers or model internals.
9. Only use the field context provided to you. Do not assume additional data.

FIELD CONTEXT (use this for all answers):
${JSON.stringify(context, null, 2)}

If the context has null/undefined values for a field the farmer asks about, say you don't have that information currently.
`;

  try {
    const reply = await callGemini(geminiConfig.apiKey, geminiConfig.model, systemPrompt, message);
    return NextResponse.json({ reply });
  } catch (err) {
    console.error('[Marudam Chat] AI error:', err);
    return NextResponse.json({ error: 'AI request failed. Please try again.' }, { status: 500 });
  }
}
