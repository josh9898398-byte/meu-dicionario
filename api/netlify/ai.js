/**
 * Netlify Functions adapter.
 * Netlify expects `exports.handler = async (event) => ({ statusCode, headers, body })`.
 * Re-uses the same logic as api/ai.js by converting the event into a Request.
 */

import handler from '../ai.js';

export async function netlifyHandler(event) {
  const request = new Request(event.rawUrl || 'https://netlify.local/api/ai', {
    method: event.httpMethod,
    headers: event.headers || {},
    body: event.body ?? undefined
  });
  const response = await handler(request);
  const body = await response.text();
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body
  };
}
