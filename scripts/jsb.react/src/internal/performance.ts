import { unstable_now } from "../scheduler";

/** React development thenable instrumentation needs a clock even without browser globals. */
export const performance = Object.freeze({ now: () => unstable_now() });
