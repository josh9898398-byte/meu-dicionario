/**
 * Shared helpers for the optional serverless endpoints.
 *
 * These functions are deliberately thin: they keep the AI / TTS API keys on the
 * server, forward a structured request and return a structured response.
 * The app works without them (device TTS + mock AI), so a deployment that
 * forgets to set the environment variables degrades gracefully with a clear
 * error message instead of pretending to work.
 *
 * Supported runtimes: Vercel (Node), Netlify Functions, Cloudflare Pages
 * Functions (see api/cloudflare-worker.js for the Workers variant).
 */

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(), ...extraHeaders }
  });
}

export function errorResponse(code, message, status = 400, details = undefined) {
  return json({ error: code, message, details }, status);
}

export async function readJson(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

export const SYSTEM_PROMPT = `Você é um lexicógrafo especialista em português brasileiro (pt-BR) que ensina alunos chineses.
Responda SOMENTE com um objeto JSON válido, sem markdown.
Regras: use português do Brasil (nunca construções de Portugal); exemplos naturais do dia a dia;
5 a 8 exemplos; tradução chinesa fiel; identifique o tipo (word/phrase/expression/sentence);
se o usuário enviar uma frase completa, extraia a expressão central e explique a gramática.
Formato: {"text","language","type","headword","partOfSpeech","translations":[],"meanings":[{"definition","note"}],
"patterns":[],"collocations":[],"examples":[{"sourceText","translation","note"}],"relatedExpressions":[],
"usageNotes":[],"difficulty","tags":[],"pronunciation":{"ipa","syllables"},"grammar",
"keyExpressions":[{"text","translation","type","note"}]}`;

export const TASK_PROMPTS = {
  analyzeVocabulary: `Tarefa: analisar o texto do usuário (uma palavra, uma expressão ou uma frase).
Se for uma FRASE completa, além de explicar a frase:
1. identifique os itens realmente úteis para aprender nessa frase — expressões fixas, verbos com regência, palavras novas;
2. devolva esses itens em "keyExpressions" (2 a 5 itens, em pt-BR, cada um com tradução em chinês e uma nota curta);
3. NÃO devolva a frase inteira dentro de keyExpressions.
Exemplo: para "Eu não dou conta de fazer isso sozinho." -> keyExpressions: "dar conta de", "sozinho", "fazer isso".`,
  explainSentence: `Tarefa: explicar a frase em português brasileiro para um aluno chinês.
Devolva: tradução chinesa, explicação gramatical curta e, em "keyExpressions", os itens que valem a pena estudar nessa frase
(expressões fixas, verbos com regência, palavras novas) — nunca a frase inteira.`,
  examples: `Tarefa: gerar MAIS exemplos naturais em português brasileiro para o texto informado.
Mantenha o mesmo sentido e contexto de uso; use situações reais do Brasil (trabalho, família, amigos, internet).
Preencha "examples" com 6 a 8 frases e "keyExpressions" com as expressões fixas usadas nos exemplos.`
};

/**
 * Calls any OpenAI-compatible chat completion endpoint and returns the raw
 * message content (a JSON string produced by the model).
 */
export async function callOpenAICompatible({ messages, model, temperature = 0.3, apiKey, baseUrl }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error(`upstream ${res.status}`), { status: res.status, detail: detail.slice(0, 500) });
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}
