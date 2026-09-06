/**
 * The trusted origins, read from `settings`.
 *
 * Its own module for one boring reason: `auth.ts` is imported by the login page's server
 * function *and* by the settings service's own consumers, and a static import in the other
 * direction would close that circle. A dynamic import inside `getAuth()` breaks it.
 *
 * A database that is not there yet — first boot, before `db:migrate` — must not stop the app
 * from serving `/health` and the setup page, so a failure here is a warning and an empty list.
 */
import { loadSettings } from "#/server/services/settings.ts";

export async function loadTrustedOrigins(): Promise<readonly string[]> {
  try {
    const settings = await loadSettings();
    return settings.trustedOrigins.filter((origin) => origin.trim() !== "");
  } catch (error) {
    console.warn(
      `auth: could not read trustedOrigins from settings (${error instanceof Error ? error.message : String(error)}); using MM_WEB_URL alone.`,
    );
    return [];
  }
}
