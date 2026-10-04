/**
 * Netlify Functions entry (ESM). Wraps the shared handler in api/tts.js.
 */

import { handleTTSRequest } from '../../api/_handlers.js';

export default async (request) => handleTTSRequest(request);

export const config = { path: '/api/tts' };
