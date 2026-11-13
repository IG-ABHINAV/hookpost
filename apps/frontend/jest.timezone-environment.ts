/* jsdom, plus setTimezone(tz) for specs whose result depends on the viewer's
 * timezone (calendar dates). A spec opts in with the docblock
 *   @jest-environment <rootDir>/apps/frontend/jest.timezone-environment.ts
 * process.env inside a spec is jest's copy, so assigning TZ there changes
 * nothing; this runs outside the sandbox and sets the worker's real TZ, which
 * Node applies to Date at once. setTimezone() with no zone, and teardown, put
 * back the TZ the run started with. */
import { TestEnvironment } from 'jest-environment-jsdom';

const applyTimezone = (tz?: string) => {
  if (tz) {
    process.env.TZ = tz;
  } else {
    delete process.env.TZ;
  }
};

export default class TimezoneEnvironment extends TestEnvironment {
  private originalTz = process.env.TZ;

  override async setup() {
    await super.setup();
    this.global.setTimezone = (tz?: string) =>
      applyTimezone(tz || this.originalTz);
  }

  override async teardown() {
    applyTimezone(this.originalTz);
    await super.teardown();
  }
}
