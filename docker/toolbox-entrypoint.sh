#!/bin/sh
# Entrypoint for the toolbox image.
#
# `docs/02-lecons-v1.md` lists "breaks at every YouTube change" as the first v1 pain. The
# answer is an auto-update: with MM_YTDLP_AUTOUPDATE=1 the container refreshes yt-dlp before
# serving, so a restart is enough to pick up a fix that landed this morning.
#
# The update is best-effort on purpose: a machine with no network, or a PyPI outage, must
# still start the service with the version baked into the image.
set -e

case "${MM_YTDLP_AUTOUPDATE:-0}" in
  1 | true | yes | on)
    echo "toolbox: updating yt-dlp (MM_YTDLP_AUTOUPDATE=${MM_YTDLP_AUTOUPDATE})" >&2
    if uv pip install --no-cache --upgrade yt-dlp >&2; then
      python -c "import yt_dlp.version as v; print('toolbox: yt-dlp', v.__version__)" >&2
    else
      echo "toolbox: yt-dlp update failed, keeping the version in the image" >&2
    fi
    ;;
esac

exec "$@"
