import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityPanel, GenerationReview } from '../src/index.ts';
import type { Asset, Attempt, Review } from '../src/index.ts';
import '../src/styles.css';

// Explicitly synthetic, local-only component fixture. No network command client.
const assets: Asset[] = ['start', 'end'].map(role => ({ id: role, projectId: 'fixture-project', filename: `red-cup-${role}.svg`, kind: 'image', origin: 'sample', sha256: `fixture-${role}`, mediaUrl: `/api/media/${role}`, width: 1600, height: 1000 }));
const baseReview: Review = { id: 'fixture-review', projectId: 'fixture-project', shotId: 'shot-cup-turn', shotRevision: 4, requestHash: 'fixture-request-hash-not-a-live-generation', prompt: 'The red cup turns slowly on a pale studio surface.\nKeep the handle visible as it moves from the start frame to the end frame. Locked camera, gentle light, no added objects.', controls: { modelId: 'minimax/hailuo-3', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: 'start', lastFrameAssetId: 'end' }, estimatedCostUsd: null, blockers: [], approved: false };
const attempts: Attempt[] = [
  { id: 'fixture-unknown', projectId: 'fixture-project', shotId: 'shot-cup-turn', shotRevision: 3, status: 'acceptance_unknown', providerJobId: null, errorCode: 'acceptance_unknown', message: 'Confirmation was not received.' },
  { id: 'fixture-blocked', projectId: 'fixture-project', shotId: 'shot-cup-turn', shotRevision: 2, status: 'blocked', providerJobId: null, errorCode: 'zdr-violation-by-account', message: 'The available endpoint was excluded by account privacy settings.' },
  { id: 'fixture-saving', projectId: 'fixture-project', shotId: 'shot-another', shotRevision: 1, status: 'retrieving', providerJobId: 'fixture-job', errorCode: null, message: null },
];
function Fixture() {
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState('');
  const [allAttempts, setAllAttempts] = useState(attempts);
  Object.assign(window, {
    fixture: {
      setReview: (patch: Partial<Review>) => setReview({ ...baseReview, ...patch }),
      approveReadback: () => setReview(current => current && { ...current, approved: true }),
      setAttempts: (next: Attempt[]) => setAllAttempts(next),
    },
  });
  return <main>
    <header className="fixture-header"><strong>Flume</strong><span>Isolated component fixture · sample media · no provider calls</span></header>
    <div className="fixture-layout">
      <div><ActivityPanel attempts={allAttempts} assets={assets} onResume={id => { setNotice(`Recovery callback: ${id}`); }} /></div>
      <aside className="fixture-preview"><h1>A cup, turning.</h1><img src="/api/media/start" alt="Synthetic red cup sample" /><p>Sample frame pair for generation review.</p><button id="open-review" type="button" onClick={() => setReview(baseReview)}>Review sample generation</button><p id="fixture-notice">{notice}</p></aside>
    </div>
    <GenerationReview review={review} assets={assets} onApprove={(id, limits) => { setNotice(`Approval callback: ${id}; maxAttempts=${limits.maxAttempts}; maxCostUsd=${limits.maxCostUsd}`); }} onSubmit={id => { setNotice(`Submission callback: ${id}`); }} onDismiss={() => setReview(null)} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
