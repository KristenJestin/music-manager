/**
 * "X is not configured" with no way to configure it is half a diagnostic (owner review B5).
 * Every row that can say that carries the link to the exact block that fixes it, which is why
 * `Section` in `components/settings/controls.tsx` grew an `id`.
 *
 * Started as a helper local to `/tools`; a failed download's error card wants the exact same
 * jump — code `YTDLP_AGE` or `YTDLP_BOT_CHECK` and action "Configure cookies" both mean
 * "go set up cookies", and someone reading a failed import should not have to find
 * Settings → Downloader on their own. One component, so the two places agree.
 */
import { Link } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";

export function ConfigureLink({
  to,
  hash,
  label = "Configure",
  testId,
}: {
  readonly to: "/settings/integrations" | "/settings/downloader" | "/settings/metadata";
  readonly hash: string;
  readonly label?: string;
  readonly testId?: string;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      nativeButton={false}
      data-testid={testId}
      render={<Link to={to} hash={hash} />}
    >
      <SlidersHorizontal className="size-3.5" aria-hidden="true" /> {label}
    </Button>
  );
}
