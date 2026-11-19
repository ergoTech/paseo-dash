import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type GitRunner, systemGit } from "../sync/git.ts";
import type { LocalProject } from "./mapping.ts";

type Paseo = PluginHandlerContext["paseo"];

/** This machine's Paseo projects with the remote URL of each git project. */
export async function localProjects(paseo: Paseo, runner: GitRunner = systemGit): Promise<LocalProject[]> {
  const { projects } = await paseo.projects.list();
  return Promise.all(
    projects.map(async (project) => {
      let remote: string | undefined;
      if (project.projectKind === "git") {
        const result = await runner.run(project.projectRootPath, ["remote", "get-url", "origin"], 5_000);
        if (result.code === 0) remote = result.stdout.trim();
      }
      return { projectId: project.projectId, name: project.projectDisplayName, remote, rootPath: project.projectRootPath, git: project.projectKind === "git" };
    }),
  );
}
