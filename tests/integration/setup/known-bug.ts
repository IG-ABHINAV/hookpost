/**
 * A test that pins down a real product bug found while writing these suites.
 * It is skipped so the nightly stays green on everything else, and its name
 * starts with "BUG:" so the report lists it. Run them with RUN_KNOWN_BUGS=1 to
 * see whether a fix has landed: a known bug that now passes should become a
 * normal test.
 */
export const knownBug: jest.It = (process.env.RUN_KNOWN_BUGS ? it : it.skip) as jest.It;
