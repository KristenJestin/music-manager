/**
 * TanStack Start augments TanStack Router's file-route options with `server.handlers`
 * (see `@tanstack/start-client-core/dist/esm/serverRoute.d.ts`). The augmentation only
 * reaches the program if something pulls the package's types in; nothing in a plain
 * server route file does, so anchor it once here.
 */
/// <reference types="@tanstack/react-start" />

export {};
