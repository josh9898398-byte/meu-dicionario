/**
 * Netlify Functions entry (ESM). Wraps the shared handler in api/ai.js.
 */

import { handleAIRequest } from '../../api/_handlers.js';

const TASKS = {
  analyze: 'analyzeVocabulary',
  explain: 'explainSentence',
  examples: 'examples'
};

export default async (request) => {
  const task = new URL(request.url).searchParams.get('task');
  return handleAIRequest(request, { task: TASKS[task] ?? null });
};

export const config = { path: '/api/ai' };
