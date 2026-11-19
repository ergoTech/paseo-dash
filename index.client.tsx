import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FeatureScreen } from "./client/feature.tsx";
import { LineScreen } from "./client/line.tsx";
import { setClient } from "./client/nav.ts";
import { SpacesSettings } from "./client/settings.tsx";
import { DashboardSidebarItem } from "./client/sidebar.tsx";
import { SpaceScreen } from "./client/space.tsx";
import { registerSurfaces } from "./client/surfaces.tsx";
import { TaskScreen } from "./client/task.tsx";
import { PLUGIN_NAME } from "./shared/edition.ts";

export default function contribute(client: PluginClientContext) {
  setClient(client);
  const cleanups = [
    client.addScreen({ id: "space", title: (params) => (params.space ? `${PLUGIN_NAME} · ${params.space}` : PLUGIN_NAME), Component: SpaceScreen }),
    client.addScreen({ id: "line", title: (params) => `Line · ${params.project ?? ""}`, Component: LineScreen }),
    client.addScreen({ id: "feature", title: "Feature", Component: FeatureScreen }),
    client.addScreen({ id: "task", title: (params) => params.task ?? "Task", Component: TaskScreen }),
    client.addSidebarHeaderItem({ id: "dashboard", title: PLUGIN_NAME, Component: DashboardSidebarItem }),
    client.addSettingsScreen({ id: "spaces", title: PLUGIN_NAME, icon: "Map", Component: SpacesSettings }),
    registerSurfaces(client),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
    setClient(undefined);
  };
}
