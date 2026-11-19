import { expect, it } from 'vitest';
import { resolveProductImageTargets } from '@ecomgen/contracts';
import { adaptProjectDetail } from '../api/adapters/projectDetail';
import { GENERATE_JOB_FIXTURE, OUTPUT_FIXTURE, PRODUCT_IMAGE_CONTEXT_FIXTURE, PROJECT_IMAGE_PLANNING_FIXTURE, STORYBOARD_ITEM_FIXTURE, projectDetailPayload } from '../test/fixtures';
import { buildTargetReviewCards } from './review';

it('keeps planned empty targets and failed legacy items visible without manufacturing images', () => {
  const targets = resolveProductImageTargets({ ...PROJECT_IMAGE_PLANNING_FIXTURE, revision: 1 });
  const detail = adaptProjectDetail(projectDetailPayload({ items: [STORYBOARD_ITEM_FIXTURE], outputs: [], jobs: [{ ...GENERATE_JOB_FIXTURE, storyboardItemId: STORYBOARD_ITEM_FIXTURE.id, status: 'FAILED', error: { message: 'provider failed' } }] }));
  const cards = buildTargetReviewCards(detail.items, detail.outputs, detail.jobs, targets);
  expect(cards.filter(card => !card.historical)).toHaveLength(targets.length);
  expect(cards.every(card => card.outputs.length === 0)).toBe(true);
  expect(cards.find(card => card.targetId === STORYBOARD_ITEM_FIXTURE.id)).toMatchObject({ status: 'FAILED', error: 'provider failed' });
  expect(cards.filter(card => !card.historical).every(card => card.status === 'EMPTY')).toBe(true);
});

it('marks output-less targets unknown when a generation request has no recoverable item association', () => {
  const detail = adaptProjectDetail(projectDetailPayload({ items: [STORYBOARD_ITEM_FIXTURE], outputs: [], jobs: [{ ...GENERATE_JOB_FIXTURE, storyboardItemId: undefined, status: 'UNKNOWN' }] }));
  expect(buildTargetReviewCards(detail.items, [], detail.jobs)[0]?.status).toBe('UNKNOWN');
});

it.each([STORYBOARD_ITEM_FIXTURE.id, undefined])('ignores read-only history when deriving current generation progress (%s)', storyboardItemId => {
  const history = { sourceVersion: 2, kind: 'GENERATE', originalStatus: 'UNKNOWN', requestState: 'UNKNOWN', executable: false, resultStatus: 'UNAVAILABLE', result: null, files: [] };
  const detail = adaptProjectDetail(projectDetailPayload({
    items: [STORYBOARD_ITEM_FIXTURE], outputs: [],
    jobs: [{ ...GENERATE_JOB_FIXTURE, storyboardItemId, status: 'UNKNOWN', history }],
  }));
  expect(detail.jobs[0]!.history).toBeDefined();
  expect(buildTargetReviewCards(detail.items, [], detail.jobs)[0]?.status).toBe('EMPTY');
  detail.jobs.push({ ...GENERATE_JOB_FIXTURE, id: '00000000-0000-4000-8000-000000000099', storyboardItemId: STORYBOARD_ITEM_FIXTURE.id, status: 'RUNNING' });
  expect(buildTargetReviewCards(detail.items, [], detail.jobs)[0]).toMatchObject({ status: 'PENDING', pendingStatus: 'RUNNING' });
});

it('maps generation lifecycle to its planned target and retains previous output during regeneration', () => {
  const targets = resolveProductImageTargets({ ...PROJECT_IMAGE_PLANNING_FIXTURE, revision: 1 });
  const item = { ...STORYBOARD_ITEM_FIXTURE, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE };
  const project = (status: 'QUEUED' | 'RUNNING' | 'FAILED' | 'SUCCEEDED', withOutput = false) => adaptProjectDetail(projectDetailPayload({
    items: [item],
    jobs: [{ ...GENERATE_JOB_FIXTURE, storyboardItemId: item.id, status, error: status === 'FAILED' ? { message: 'provider failed' } : null }],
    outputs: withOutput ? [{ ...OUTPUT_FIXTURE, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE }] : [],
  }));
  const card = (status: 'QUEUED' | 'RUNNING' | 'FAILED' | 'SUCCEEDED', withOutput = false) => {
    const detail = project(status, withOutput);
    return buildTargetReviewCards(detail.items, detail.outputs, detail.jobs, targets).find(entry => entry.targetId === PRODUCT_IMAGE_CONTEXT_FIXTURE.targetId);
  };
  expect(card('QUEUED')).toMatchObject({ status: 'PENDING', pendingStatus: 'QUEUED', outputs: [] });
  expect(card('RUNNING')).toMatchObject({ status: 'PENDING', pendingStatus: 'RUNNING', outputs: [] });
  expect(card('FAILED')).toMatchObject({ status: 'FAILED', error: 'provider failed' });
  expect(card('SUCCEEDED', true)).toMatchObject({ status: 'READY', outputs: [{ id: OUTPUT_FIXTURE.id }] });
  expect(card('RUNNING', true)).toMatchObject({ status: 'PENDING', pendingStatus: 'RUNNING', outputs: [{ id: OUTPUT_FIXTURE.id }] });
  expect(card('FAILED', true)).toMatchObject({ status: 'READY', outputs: [{ id: OUTPUT_FIXTURE.id }] });
});
