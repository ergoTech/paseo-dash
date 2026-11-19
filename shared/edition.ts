import { EDITION } from "./edition.generated.ts";

/**
 * Which copy of the plugin this is: the one Paseo installed from git, or a working copy installed
 * next to it for development (`--id dashboard-dev`). Paseo does not tell a plugin the id it runs
 * under, so scripts/edition.mjs writes the generated module when the checkout is installed. The
 * development copy names itself apart, so the two never read the same in Paseo or in ChatGPT.
 */
export const DEV = EDITION === "dev";

export const PLUGIN_NAME_RELEASE = "Paseo Dash";
export const PLUGIN_NAME_DEV = "Paseo Dash Dev";

/** The plugin's name wherever a person reads it: Paseo's sidebar, screens and settings, and ChatGPT. */
export const PLUGIN_NAME = DEV ? PLUGIN_NAME_DEV : PLUGIN_NAME_RELEASE;
