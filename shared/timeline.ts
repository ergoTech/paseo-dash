/**
 * The timeline card a start appends to its agent (04-ux.md, Surfaces) and the client renders. Paseo
 * scopes plugin timeline items by plugin id itself, and accepts a renderer kind only of the form
 * `^[a-z][a-z0-9-]*$`, so the kind is a plain word.
 */
export const STARTED_CARD = { kind: "started", version: 1 } as const;
