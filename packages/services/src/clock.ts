// The clock port: services take one instead of calling `new Date()`, so tests can
// pin the time. The first of the ports services receive (see docs/architecture.md).
// TODO(cms-port): more ports (repos, KV, R2, AI) arrive with the CMS services.

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
