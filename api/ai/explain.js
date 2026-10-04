import { handleAIRequest } from '../_handlers.js';

export const config = { runtime: 'edge' };

/** POST /api/ai/explain — 解释整句（含句中值得学习的表达） */
export default async function handler(request) {
  return handleAIRequest(request, { task: 'explainSentence' });
}
