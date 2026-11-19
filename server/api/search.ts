import type { Task } from "../../shared/model.ts";
import type { LoadedEntity } from "../plan/load.ts";
import { matchOne, parseQuery as parse, type Query, quoteAround, type SearchField } from "../search/core.ts";

/**
 * One task against a query, as the plan's search reads it (server/search/core.ts): the field the
 * match is in and a quote of it. Lists search through the core, which ranks and allows typos; this
 * answers for a single task, without the plan around it.
 */

export { quoteAround };
export type SearchQuery = Query;

export interface TaskMatch {
  field: SearchField;
  /** A short piece of that field around the match, on one line. */
  quote: string;
  /** The task's own id, PR/MR, issue, link or branch, rather than words found in its text. */
  exact: boolean;
}

/** The query, or undefined when it has nothing to look for (no letter or digit): no filter then. */
export function parseQuery(text: string): SearchQuery | undefined {
  return parse(text);
}

/** Where the task matches the query, or undefined when it does not. */
export function matchTask(_task: Task, loaded: LoadedEntity, query: SearchQuery): TaskMatch | undefined {
  const match = matchOne(loaded, undefined, query);
  return match && { field: match.field, quote: match.quote, exact: match.exact };
}
