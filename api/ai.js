/**
 * 兼容入口（旧地址）。推荐使用：
 *   POST /api/ai/analyze   POST /api/ai/explain   POST /api/ai/examples   GET /api/ai/status
 *
 * 服务器端环境变量：OPENAI_API_KEY（必需）、AI_MODEL、AI_BASE_URL、AI_SHARED_SECRET。
 * 密钥只存在服务器，前端永远拿不到。
 */

import { handleAIRequest } from './_handlers.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  return handleAIRequest(request);
}
