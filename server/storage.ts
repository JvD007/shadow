// GridWeave Inspector is a stateless tool — no DB needed.
// This file is kept as a placeholder so existing imports keep working.

export interface IStorage {}

export class NoopStorage implements IStorage {}

export const storage = new NoopStorage();
