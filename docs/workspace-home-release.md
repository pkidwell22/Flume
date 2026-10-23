# Workspace Home and reference analysis

This publication brings the previously local running app source into GitHub: Kimi/Ollama reference analysis, bounded sampled-video provenance, provider-reader cancellation, RGB media verification, Workspace Home, guarded navigation/history, pending-review preservation and accessible showreel playback.

## Executed verification

- Full build and typecheck: passed.
- Focused non-database server suite:61/61 passed.
- Web suite:120/120 passed.
- Focused media suite:20/20 passed.
- Isolated publication frontend with the existing read-only backend: actual muted playback, natural advance, manual slide/pause, visibility fencing, reduced motion and mobile overflow checks passed. Desktop/mobile screenshots inspected.
- Independent read-only publication audit and code review completed. The deduplication-fingerprint documentation was corrected to distinguish pre-visual context from recorded resolved reference provenance.

Database/infrastructure suites were not run; no IPC cleanup or runtime-store migration was performed. GitHub security checks are a separate publication gate, not these application tests.

## Creative assets

The existing showreel is preserved as the running-app baseline; technical verification does not mean its creative direction is final. New [original asset studies](assets/mercy-studies/README.md) are separate from the active showreel. Publishing them does not trigger generation or replace the running carousel. No private creator-research media, account credentials, runtime stores or unrelated Audio work are included.
