import { handleAIRequest } from '../_handlers.js';

export const config = { runtime: 'edge' };

/** POST /api/ai/analyze — 单词 / 短语 / 句子的结构化分析 */
export default async function handler(request) {
  return handleAIRequest(request, { task: 'analyzeVocabulary' });
}
