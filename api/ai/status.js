import { handleAIRequest } from '../_handlers.js';

export const config = { runtime: 'edge' };

/** GET /api/ai/status — 前端据此显示「AI 是否已启用」，不涉及任何密钥 */
export default async function handler(request) {
  return handleAIRequest(request);
}
