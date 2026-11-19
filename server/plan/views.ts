/**
 * Obsidian Bases views a new space starts with (04-ux.md, For people without Paseo). Written once when
 * the space is created; after that they belong to the people who use them and the plugin never
 * rewrites them. Syntax per https://obsidian.md/help/bases/syntax: `type: kanban` with `groupBy` and
 * `groupOrder` is the kanban layout Bases gained in Obsidian 1.14.
 */

export const VIEW_FILES: Record<string, string> = {
  "views/tasks.base": `filters:
  and:
    - file.inFolder("tasks")
views:
  - type: table
    name: Open tasks
    filters:
      and:
        - 'status != "done"'
        - 'status != "canceled"'
    order:
      - file.name
      - note.status
      - note.project
      - note.feature
      - note.milestone
      - note.priority
      - note.assignee
      - note.labels
  - type: kanban
    name: Board
    groupBy:
      property: note.status
      direction: ASC
    groupOrder:
      - inbox
      - todo
      - in_progress
      - review
      - done
    order:
      - file.name
      - note.project
      - note.priority
      - note.labels
`,
  "views/roadmap.base": `filters:
  and:
    - file.inFolder("features")
views:
  - type: table
    name: Features by release
    groupBy:
      property: note.milestone
      direction: ASC
    order:
      - file.name
      - note.status
      - note.branch
      - note.projects
`,
};
