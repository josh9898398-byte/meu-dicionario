import { handleTTSRequest } from '../_handlers.js';

export const config = { runtime: 'edge' };

/** POST /api/tts/speak — 巴西葡语 (pt-BR) 神经网络语音，返回 MP3 */
export default async function handler(request) {
  return handleTTSRequest(request);
}
