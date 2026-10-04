/**
 * 兼容入口（旧地址）。推荐使用：
 *   POST /api/tts/speak    GET /api/tts/status
 *
 * 服务器端环境变量：TTS_PROVIDER + 对应服务商密钥（OPENAI_API_KEY / AZURE_* / …）。
 * 密钥只存在服务器。
 */

import { handleTTSRequest } from './_handlers.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  return handleTTSRequest(request);
}
