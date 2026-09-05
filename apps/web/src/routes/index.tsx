import { createFileRoute } from "@tanstack/react-router";
import { APP_VERSION } from "#/server/version.ts";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">Music Manager</h1>
        <p className="text-fg-3 font-mono text-2xs">v{APP_VERSION}</p>
      </div>
    </main>
  );
}
