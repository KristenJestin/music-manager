/**
 * The Settings tab strip, in one list.
 *
 * A registry rather than JSX inside the layout, because two phases fill this page in
 * parallel: P07a owns "Library & files" and "Metadata & matching", P07b owns "Downloader" and
 * "Integrations". Adding a tab is one line here and one route file, and neither agent has to
 * edit the other's markup.
 *
 * `to` is the literal route path; the layout renders it with a `<Link>`, so a typo is a build
 * error rather than a dead tab.
 */
export interface SettingsTab {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  readonly hint: string;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  {
    id: "library",
    label: "Library & files",
    to: "/settings/library",
    hint: "Where files go, how names are sanitised, which sidecars are written.",
  },
  {
    id: "downloader",
    label: "Downloader",
    to: "/settings/downloader",
    hint: "yt-dlp: updates, cookies, anti-ban pacing, and the binaries behind it.",
  },
  {
    id: "metadata",
    label: "Metadata & matching",
    to: "/settings/metadata",
    hint: "Sources, credentials, matching weights and the tag schema.",
  },
  {
    id: "integrations",
    label: "Integrations",
    to: "/settings/integrations",
    hint: "Navidrome, notifications and the backup.",
  },
];
