import { handleTTSRequest } from '../_handlers.js';

export const config = { runtime: 'edge' };

/** GET /api/tts/status */
export default async function handler(request) {
  return handleTTSRequest(request);
}
