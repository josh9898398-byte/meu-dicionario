/**
 * Cloudflare Workers entry point (also usable as a Pages Function).
 *
 * Add to wrangler.toml:
 *   [vars] AI_MODEL = "gpt-4o-mini"
 * and set secrets with `wrangler secret put OPENAI_API_KEY`.
 */

import { handleAIRequest, handleTTSRequest } from './_handlers.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (path.startsWith('/api/ai') || path === '/ai') {
      if (path.endsWith('/explain')) return handleAIRequest(request, { task: 'explainSentence' });
      if (path.endsWith('/examples')) return handleAIRequest(request, { task: 'examples' });
      if (path.endsWith('/analyze')) return handleAIRequest(request, { task: 'analyzeVocabulary' });
      return handleAIRequest(request);
    }
    if (path.startsWith('/api/tts') || path === '/tts') return handleTTSRequest(request);

    return new Response(JSON.stringify({ error: 'not-found', path: url.pathname }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
