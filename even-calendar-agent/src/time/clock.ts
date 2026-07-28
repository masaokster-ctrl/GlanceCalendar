export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(isoOrDate: string | Date): Clock {
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return { now: () => date };
}
