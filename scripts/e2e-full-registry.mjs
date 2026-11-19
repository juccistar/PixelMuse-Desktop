import { businessScenarios } from './e2e-full-business.mjs';
import { editLayerScenarios } from './e2e-full-edit-layers.mjs';
import { patternScenarios, pipelineScenarios } from './e2e-full-patterns.mjs';
import { additionalScenarios } from './e2e-full-additional.mjs';
import { recoveryScenarios } from './e2e-full-recovery.mjs';
import { uiScenarios } from './e2e-full-ui.mjs';

// Dependencies describe actual shared fixtures. Unrelated scenarios continue after failures.
const dependencies = {
  'search-sources': ['provider-multimodel'],
  'project-facts-assets': ['provider-multimodel'],
  'project-lifecycle': ['project-facts-assets'],
  'library-copy-filters': ['project-facts-assets'],
  'custom-templates': ['provider-multimodel'],
  'creative-ai-manual': ['provider-multimodel'],
  'protected-truth': ['provider-multimodel'],
  'storyboard-candidates': ['project-facts-assets'],
  'planning-history': ['provider-multimodel'],
  'copywriting-records': ['project-facts-assets'],
  'suite-forge': ['provider-multimodel'],
  'edit-memory-references': ['storyboard-candidates'],
  'edit-confirmation': ['edit-memory-references'],
  'edit-need-input': ['storyboard-candidates'],
  'edit-mask-protection': ['storyboard-candidates'],
  'edit-outpaint': ['storyboard-candidates'],
  'layer-auto-manual-sam': ['storyboard-candidates'],
  'export-zip-long-image': ['storyboard-candidates'],
  'global-models': ['provider-multimodel'],
  'pattern-import': ['provider-multimodel'],
  'pattern-forge-variant-recolor-tile': ['pattern-import'],
  'pattern-print-listing': ['pattern-import'],
  'draft-media-cas': ['pattern-import'],
  'draft-generate-slots': ['draft-media-cas'],
  'draft-edit-cutout-process-seam': ['draft-generate-slots'],
  'draft-compare-finalize': ['draft-generate-slots'],
  'pipeline-full-chain': ['provider-multimodel'],
  'pipeline-source-cancel-retry': ['pipeline-full-chain'],
  'events-invalidation': ['project-facts-assets'],
  'asset-domain-limits': ['provider-multimodel'],
  'asset-readable-formats': ['provider-multimodel'],
  'planning-domain-boundaries': ['provider-multimodel'],
  'research-real-tool-audit': ['search-sources'],
  'catalog-crud-resource-handles': ['storyboard-candidates'],
  'reference-promotion': ['edit-memory-references'],
  'deletion-and-reference-cleanup': ['provider-multimodel'],
  'ipc-path-secret-boundaries': ['project-facts-assets'],
  'draft-partial-retry': ['provider-multimodel'],
  'receipt-replay-download-failure': ['provider-multimodel'],
  'unknown-no-retry': ['provider-multimodel'],
  'abort-inflight': ['provider-multimodel'],
  'backend-crash-status': ['project-facts-assets'],
  'persisted-records-restart': ['storyboard-candidates'],
  'ui-provider-setup': ['provider-multimodel'],
  'ui-project-workbench': ['provider-multimodel'],
  'ui-upload-drop-paste': ['ui-project-workbench'],
  'ui-copy-adoption-late-write': ['ui-upload-drop-paste'],
  'ui-edit-canvas': ['ui-project-workbench'],
  'ui-auto-layers-export-compose': ['ui-project-workbench'],
  'ui-suite-forge': ['provider-multimodel'],
  'ui-model-designer': ['provider-multimodel'],
  'ui-draft-and-pattern-routes': ['provider-multimodel'],
  'ui-library-copy': ['project-facts-assets'],
  'ui-routes-theme': uiScenarios.filter(s => s.id !== 'ui-routes-theme').map(s => s.id),
};
for (const protocol of ['grounded_sam', 'gitee_sam3', 'seedream_layerize']) dependencies[`layer-${protocol}`] = ['storyboard-candidates'];
for (const mode of ['segment', 'generate']) dependencies[`pattern-extract-${mode}`] = ['provider-multimodel'];
for (const resolution of ['use_centered', 'use_mirror', 'allow_seam']) dependencies[`pipeline-seam-${resolution}`] = ['provider-multimodel'];

export const scenarioModules = [
  'e2e-full-business.mjs', 'e2e-full-edit-layers.mjs', 'e2e-full-patterns.mjs',
  'e2e-full-additional.mjs', 'e2e-full-recovery.mjs', 'e2e-full-ui.mjs',
];
export const scenarios = [
  ...businessScenarios, ...editLayerScenarios, ...patternScenarios, ...pipelineScenarios,
  ...additionalScenarios, ...uiScenarios,
  ...recoveryScenarios.filter(s => s.id !== 'isolated-v2-upgrade'),
  ...recoveryScenarios.filter(s => s.id === 'isolated-v2-upgrade'),
].map(s => ({ ...s, needs: dependencies[s.id] ?? [] }));

// Baseline map-4 family -> mandatory behavior scenarios; these are coverage assignments, not proof of execution.
export const featureScenarios = {
  '01-project-lifecycle': ['project-lifecycle', 'ui-project-workbench'],
  '02-project-assets': ['project-facts-assets', 'asset-domain-limits', 'asset-readable-formats', 'ui-upload-drop-paste'],
  '03-global-asset-library': ['library-copy-filters', 'global-models', 'ui-library-copy'],
  '04-provider-settings': ['provider-multimodel', 'ui-provider-setup', 'deletion-and-reference-cleanup'],
  '05-business-settings-and-localization': ['project-facts-assets', 'ui-project-workbench', 'persisted-records-restart'],
  '06-product-copywriting': ['copywriting-records', 'ui-copy-adoption-late-write'],
  '07-custom-templates': ['custom-templates'],
  '08-planning-history-and-validation': ['creative-ai-manual', 'protected-truth', 'planning-domain-boundaries', 'planning-history'],
  '09-web-research': ['search-sources', 'research-real-tool-audit'],
  '10-storyboard-editor': ['storyboard-candidates', 'ui-project-workbench'],
  '11-generation-batches-and-candidates': ['storyboard-candidates', 'draft-partial-retry'],
  '12-results-and-export': ['export-zip-long-image', 'ui-project-workbench'],
  '13-edit-sessions-and-masks': ['edit-memory-references', 'edit-confirmation', 'edit-need-input', 'edit-mask-protection', 'edit-outpaint', 'reference-promotion', 'ui-edit-canvas'],
  '14-segmentation-protocols': ['layer-auto-manual-sam', 'layer-grounded_sam', 'layer-gitee_sam3'],
  '15-automatic-layer-plans-and-exports': ['layer-auto-manual-sam', 'layer-seedream_layerize', 'ui-auto-layers-export-compose'],
  '16-layer-stack-and-artifact-integrity': ['layer-auto-manual-sam', 'export-zip-long-image', 'ui-auto-layers-export-compose'],
  '17-suite-catalog-and-forge': ['suite-forge', 'catalog-crud-resource-handles', 'ui-suite-forge'],
  '18-model-cast-library': ['global-models', 'ui-model-designer', 'deletion-and-reference-cleanup'],
  '19-pattern-library-and-source-entry': ['pattern-import', 'pattern-extract-segment', 'pattern-extract-generate', 'pattern-forge-variant-recolor-tile'],
  '20-pattern-draft-aggregate-and-batches': ['draft-media-cas', 'draft-generate-slots', 'draft-partial-retry', 'draft-compare-finalize', 'ui-draft-and-pattern-routes'],
  '21-pattern-drawing-and-editing': ['draft-edit-cutout-process-seam', 'ui-draft-and-pattern-routes'],
  '22-pattern-derive-and-tileability': ['pattern-forge-variant-recolor-tile', 'draft-edit-cutout-process-seam'],
  '23-seam-edit-and-repeat-units': ['draft-edit-cutout-process-seam', 'pattern-print-listing'],
  '24-print-packs': ['pattern-print-listing', 'pipeline-full-chain'],
  '25-listing-copy': ['pattern-print-listing'],
  '26-packaging-pipelines': ['pipeline-full-chain', 'pipeline-seam-use_centered', 'pipeline-seam-use_mirror', 'pipeline-seam-allow_seam', 'pipeline-source-cancel-retry'],
  '27-durable-jobs-and-unknown-requests': ['draft-partial-retry', 'receipt-replay-download-failure', 'unknown-no-retry', 'abort-inflight', 'backend-crash-status', 'persisted-records-restart'],
  '28-schema-v2-to-v3': ['isolated-v2-upgrade'],
  '29-packaged-runtime-and-ui': ['ui-routes-theme', 'ipc-path-secret-boundaries', 'persisted-records-restart'],
};

export function completionSummary(records, inventory) {
  const passed = records.filter(row => row.status === 'passed');
  const requiredJobs = [...inventory.kinds, ...inventory.additionalBranches.map(b => `${b.kind}:${b.target}`)];
  const successfulJobs = new Set(passed.flatMap(row => (row.jobs ?? []).filter(job => job.status === 'SUCCEEDED').map(job => job.type)));
  const branches = new Set(passed.flatMap(row => row.verifiedBranches ?? []));
  const missingJobTypes = requiredJobs.filter(type => !(type.includes(':') ? branches : successfulJobs).has(type));
  const counts = Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, records.filter(row => row.status === status).length]));
  return { counts, assertions: records.reduce((sum, row) => sum + row.assertions, 0), missingJobTypes,
    complete: counts.failed === 0 && counts.blocked === 0 && records.length === scenarios.length && missingJobTypes.length === 0 };
}
