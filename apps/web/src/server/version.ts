import pkg from "../../package.json";

/** Single source of truth for the version reported by `/` and `/health`. */
export const APP_VERSION: string = pkg.version;
