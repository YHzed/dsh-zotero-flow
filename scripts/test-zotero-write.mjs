/**
 * Disabled legacy live-write test.
 * It used a real DOI and could append a synthetic PDF to a genuine item after
 * deduplication was introduced. Keep this entrypoint fail-closed so old commands
 * cannot mutate a user's library. Use mocked regression tests instead.
 */
console.error('Live Zotero write self-test is disabled: the legacy test used a real article identity.');
console.error('Run npm test for mocked import, attachment, authorization and security regressions.');
console.error('For a real write check, use an isolated Zotero test profile and an explicitly selected test PDF/item.');
process.exitCode = 1;
