/**
 * Runtime configuration.
 *
 * This file is safe to edit by hand, and `npm run build` will overwrite it in
 * `dist/` using environment variables (see README "环境变量说明").
 *
 * Everything here is OPTIONAL. With empty values the app still works as a
 * fully offline dictionary + vocabulary notebook; only the online features
 * (AI analysis, neural TTS) need a proxy or a user-supplied API key.
 */
window.__APP_CONFIG__ = {
  // Version stamp. The build script overwrites this with the release version.
  version: '1.0.0',

  // Endpoint used by AIService for structured vocabulary analysis.
  // Ships with the project as `api/ai.js` (Vercel / Netlify functions / Cloudflare Pages Functions).
  aiProxyUrl: '/api/ai',

  // Endpoint used by TTSService to synthesize natural pt-BR speech.
  ttsProxyUrl: '/api/tts',

  // Optional: force a client-side provider so the request never touches your proxy.
  // 'auto' | 'proxy' | 'openai' | 'device'
  aiTransport: 'auto',
  ttsTransport: 'auto',

  // Optional URL of a remote resource catalog (JSON) for the Resource Center.
  // Leave empty to use the catalog bundled with the app.
  resourceCatalogUrl: '',

  // Set to false to hide the "示例数据（非 AI）" mock provider in AI settings.
  allowMockAI: true
};
