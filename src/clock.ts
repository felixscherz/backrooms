/** The current time and the time zone that local times are written in. A seam, so tests can fix the time. */
export type Clock = { now(): Date; timeZone: string };

/** The system's clock, in the time zone of the process, which `TZ` sets. */
export const systemClock: Clock = {
  now: () => new Date(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
