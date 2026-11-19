import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { cleanLabel, findLabel, LABEL_RULE, labelsPutRpc, labelsRemoveRpc, nextLabelColor, peoplePutRpc, peopleRemoveRpc } from "../../shared/labels.ts";
import { LINE_COLOR_PATTERN, PERSON_KEY_PATTERN } from "../../shared/model.ts";
import { opaqueId } from "../plan/ids.ts";
import { labelFields, personFields } from "../plan/space-file.ts";
import type { Operation } from "../sync/ops.ts";
import type { SpaceEntry } from "./resolve.ts";
import { ownerError, record, refusal, type WriteContext } from "./writes.ts";

/**
 * The label palette and the people of a space (shared/labels.ts): what the dashboard's People &
 * labels tab changes. Each change is one journaled `label_def` or `person` operation on space.yaml,
 * made from what the space says now; God Mode is not offered them.
 */

type Answer = RpcOutput<typeof labelsPutRpc>;
const fail = (error: string): Answer => ({ ok: false, error });

function spaceOf(ctx: WriteContext, key: string): SpaceEntry | undefined {
  return ctx.dashboard.spaces.get(key.trim().toUpperCase());
}

async function write(ctx: WriteContext, space: SpaceEntry, op: Operation): Promise<Answer> {
  const reason = refusal((await record(ctx, space, [op])).get(op.op_id));
  return reason ? fail(reason) : { ok: true, error: "" };
}

function ready(ctx: WriteContext, key: string): SpaceEntry | string {
  const owner = ownerError(ctx);
  if (owner) return owner;
  const space = spaceOf(ctx, key);
  if (!space) return `No space ${key}.`;
  if (!space.sync.plan.space) return "space.yaml cannot be read; fix it first";
  return space;
}

export async function putLabel(ctx: WriteContext, input: RpcInput<typeof labelsPutRpc>): Promise<Answer> {
  const space = ready(ctx, input.space);
  if (typeof space === "string") return fail(space);
  const palette = space.sync.plan.space!.labels;
  const found = findLabel(palette, input.name);
  // A label already in the palette keeps its spelling there; a new one must be a usable name.
  const name = found?.[0] ?? cleanLabel(input.name);
  if (!name) return fail(`«${input.name}» is not a usable label: ${LABEL_RULE}.`);
  const color = input.color?.trim() ?? "";
  if (color && !LINE_COLOR_PATTERN.test(color)) return fail(`${JSON.stringify(color)} is not a color #rrggbb`);
  const current = labelFields(found?.[1]);
  const value = labelFields({
    color: color || found?.[1].color || nextLabelColor(palette),
    description: input.description === undefined ? found?.[1].description : input.description.trim() || undefined,
  });
  return write(ctx, space, { op_id: opaqueId("op"), kind: "label_def", name, value, expect: current });
}

export async function removeLabel(ctx: WriteContext, input: RpcInput<typeof labelsRemoveRpc>): Promise<Answer> {
  const space = ready(ctx, input.space);
  if (typeof space === "string") return fail(space);
  const found = findLabel(space.sync.plan.space!.labels, input.name);
  if (!found) return fail(`The palette has no label ${input.name}.`);
  return write(ctx, space, { op_id: opaqueId("op"), kind: "label_def", name: found[0], value: null, expect: labelFields(found[1]) });
}

export async function putPerson(ctx: WriteContext, input: RpcInput<typeof peoplePutRpc>): Promise<Answer> {
  const space = ready(ctx, input.space);
  if (typeof space === "string") return fail(space);
  const people = space.sync.plan.space!.people;
  const key = input.key.trim();
  const listed = Object.hasOwn(people, key);
  if (!listed && !PERSON_KEY_PATTERN.test(key)) return fail(`${JSON.stringify(key)} is not a person key: lower-case letters, digits, - and _, starting with a letter`);
  const bad = input.emails.find((email) => !/^[^\s@]+@[^\s@]+$/.test(email));
  if (bad) return fail(`${JSON.stringify(bad)} is not an email`);
  const gitlab: Record<string, string> = {};
  for (const { host, login } of input.gitlab) {
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return fail(`${JSON.stringify(host)} is not a host name`);
    if (Object.hasOwn(gitlab, host)) return fail(`${host} is given twice`);
    gitlab[host] = login;
  }
  const value = personFields({ name: input.name, emails: input.emails, github: input.github, gitlab });
  const expect = listed ? personFields(people[key]) : null;
  return write(ctx, space, { op_id: opaqueId("op"), kind: "person", key, value: value ?? {}, expect });
}

export async function removePerson(ctx: WriteContext, input: RpcInput<typeof peopleRemoveRpc>): Promise<Answer> {
  const space = ready(ctx, input.space);
  if (typeof space === "string") return fail(space);
  const people = space.sync.plan.space!.people;
  const key = input.key.trim();
  if (!Object.hasOwn(people, key)) return fail(`space.yaml lists no person ${key}.`);
  return write(ctx, space, { op_id: opaqueId("op"), kind: "person", key, value: null, expect: personFields(people[key]) });
}
