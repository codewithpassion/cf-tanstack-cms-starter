// The clock port: services take one instead of calling `new Date()`, so tests can
// pin the time. One of the ports services receive (see docs/architecture.md).

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
