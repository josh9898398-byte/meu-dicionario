import { handleAIRequest } from '../_handlers.js';

export const config = { runtime: 'edge' };

/** POST /api/ai/examples — 为已有词条生成更多巴西葡语例句 */
export default async function handler(request) {
  return handleAIRequest(request, { task: 'examples' });
}
