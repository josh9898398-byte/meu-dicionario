/**
 * Service registry.
 *
 * The rest of the app imports from here so that providers (AI/TTS), storage and
 * dictionary sources can be swapped without touching UI code.
 */

export * as dictionary from './dictionaryService.js';
export * as SRS from './srsService.js';
export * as AI from './aiService.js';
export * as TTS from './ttsService.js';
export * as importer from './importService.js';
export * as exporter from './exportService.js';
export * as resources from './resourceService.js';
export * as connectivity from './connectivityService.js';
export * as diagnostics from './diagnosticsService.js';
export * as normalizer from './normalizer.js';
export * as spreadsheet from './csvParser.js';

export { AIService } from './aiService.js';
export { TTSService } from './ttsService.js';
export { dictionaryService } from './dictionaryService.js';
export { srsService } from './srsService.js';
export { importService } from './importService.js';
export { exportService } from './exportService.js';
export { resourceService } from './resourceService.js';
export { diagnosticsService } from './diagnosticsService.js';
