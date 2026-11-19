import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/**
 * Paseo's API as the SDK hands it to RPC handlers. Taken through `@getpaseo/plugin/server`, which the
 * host supplies: a plugin installed from git has no `@getpaseo/client` of its own, and Paseo's build
 * refuses a type import it cannot resolve in the plugin's own dependencies.
 */
export type PaseoApi = PluginHandlerContext["paseo"];
