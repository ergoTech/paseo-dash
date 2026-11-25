import type { PaseoApi } from "../paseo.ts";
import { POLICY_PROVIDER, type PolicyPick, TIER_SETTINGS } from "./model-policy.ts";

/**
 * Agent settings for a start (05-architecture.md, What a start sends): the task's profile, else the
 * space's default profile, else this Mac's first available provider with its defaults. Profiles are
 * Paseo's own (`config.agentProfiles`); only those entries are read from the daemon config, which
 * also holds provider keys and environment. The mode is the one a person picked at the start, else
 * the profile's, else the space's (`defaults.mode`, where the provider has it), else this Mac's start
 * default (Settings → Autopilot, where the provider has it and it does not skip permission prompts),
 * else the one the provider declares as its default (`defaultModeId` of the providers snapshot),
 * passed explicitly because an agent created without a mode may come up in one that waits for
 * permission prompts. The effort (thinking option) is likewise the one picked at the start, else the
 * profile's, else this Mac's start default (where the model has it), else the model's declared
 * default, passed explicitly so the agent runs with the effort the start showed. A Mac default the
 * provider or model lacks is said in the text, never dropped silently.
 *
 * The model is the one picked at the start, else the profile's, else, where no profile applies and
 * this Mac's provider is Claude, the one the task's policy picks (server/runner/model-policy.ts) with
 * its effort just below the profile's, else the provider's default model. A policy model Paseo does
 * not offer here leaves the provider's default model and the efforts below the policy, and says so.
 */

/** A provider's mode as the start confirmation offers it; `asks` when it stops for the user. */
export interface ModeOption {
  id: string;
  label: string;
  asks: boolean;
}

/** Paseo's colour tiers of modes that stop for the user: "Always Ask" is `safe`, "Plan Mode" `planning`. */
const ASKING_TIERS = new Set(["safe", "planning"]);
/** The tier of modes that skip permission prompts ("Bypass", "Full Access"): never taken from a plan file. */
const DANGEROUS_TIER = "dangerous";

/** One of the chosen model's efforts (thinking options), as the start confirmation offers it. */
export interface EffortOption {
  id: string;
  label: string;
}

/** One of the provider's models, as the start confirmation offers it. */
export interface ModelOption {
  id: string;
  label: string;
}

/** The fields of a model in `providers.listModels` a start uses. */
interface ModelEntry {
  id: string;
  label?: string;
  aliases?: string[];
  isDefault?: boolean;
  isSelectable?: boolean;
  thinkingOptions?: { id: string; label?: string; isDefault?: boolean }[];
  defaultThinkingOptionId?: string;
}

/** The fields of Paseo 0.13's `AgentProfileSchema` a start uses. */
export interface AgentProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export interface AgentSettings {
  /** `provider` or `provider/model`, as `agents.create` takes it. */
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  /** How a person hears it: "Implementation (the space's)". */
  label: string;
  /** The mode and where it comes from, as a person hears it: "Auto mode (auto, the provider's default)". */
  mode: string;
  /** The provider's modes, for picking another at the start; empty when Paseo did not list them. */
  modes: ModeOption[];
  /** The chosen mode stops for the user's approval (Always Ask, Plan Mode): the agent waits for a person. */
  asks: boolean;
  /** The effort and where it comes from, as a person hears it: "Medium (medium, the model's default)". */
  effort: string;
  /** The model's efforts, for picking another at the start; empty when Paseo did not list them. */
  efforts: EffortOption[];
  /** The model id the start passes (the part after `provider/`). */
  modelId: string;
  /** The model and where it comes from, as a person hears it: "Sonnet 5.5 (claude-sonnet-5-5, picked for the task: …)". */
  model: string;
  /** Models to pick another at the start: the policy's, the provider's default and the chosen one; empty when Paseo did not list them. */
  models: ModelOption[];
  /** The agent profiles on this Mac, by name, for picking one at the start. */
  profiles: string[];
}

export type ProfileChoice = { ok: true; settings: AgentSettings } | { ok: false; error: string };

const CACHE_MS = 60_000;
/** This Mac's default mode (Settings → Autopilot): a mode id of one provider. */
export interface MacMode {
  id: string;
  provider: string;
}

/** Where a mode or effort from Settings → Autopilot comes from, as a person hears it. */
const MAC_DEFAULT = "this Mac's default";

export class Profiles {
  private cached: { at: number; profiles: AgentProfile[]; firstProvider: string | undefined } | undefined;
  private readonly now: () => number;
  private readonly models = new Map<string, { at: number; models: ModelEntry[] }>();
  private snapshot: { at: number; entries: { provider: string; status: string; defaultModeId?: string | null; modes?: { id: string; label: string; colorTier?: string }[] }[] } | undefined;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async load(paseo: PaseoApi): Promise<{ profiles: AgentProfile[]; firstProvider: string | undefined }> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached;
    const { config } = await paseo.config.get();
    const raw = (config as { agentProfiles?: unknown }).agentProfiles;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
    const profiles: AgentProfile[] = [];
    for (const entry of list as Record<string, unknown>[]) {
      if (typeof entry?.name !== "string" || typeof entry.provider !== "string") continue;
      profiles.push({
        id: String(entry.id ?? entry.name),
        name: entry.name,
        provider: entry.provider,
        model: typeof entry.model === "string" ? entry.model : undefined,
        modeId: typeof entry.modeId === "string" ? entry.modeId : undefined,
        thinkingOptionId: typeof entry.thinkingOptionId === "string" ? entry.thinkingOptionId : undefined,
        featureValues:
          entry.featureValues && typeof entry.featureValues === "object" && !Array.isArray(entry.featureValues)
            ? (entry.featureValues as Record<string, unknown>)
            : undefined,
      });
    }
    const available = await paseo.providers.listAvailable();
    const firstProvider = available.providers?.find((p) => p.available)?.provider;
    this.cached = { at: this.now(), profiles, firstProvider };
    return this.cached;
  }

  /**
   * A profile the caller asked for must exist on this Mac; the task's or the space's may be missing
   * here, and then the next level applies.
   */
  async choose(
    paseo: PaseoApi,
    levels: {
      asked?: string;
      task?: string;
      space?: string;
      mode?: { asked?: string; space?: string; mac?: MacMode };
      effort?: string;
      macEffort?: string;
      /** A model id picked at the start: one of the chosen provider's. */
      model?: string;
      /** The task's pick (server/runner/model-policy.ts); absent when this Mac turned the policy off. */
      policy?: PolicyPick;
    },
  ): Promise<ProfileChoice> {
    const { profiles, firstProvider } = await this.load(paseo);
    const find = (name: string) => profiles.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
    const names = profiles.map((p) => p.name);
    const model = { asked: levels.model };
    if (levels.asked) {
      const found = find(levels.asked);
      if (!found) return { ok: false, error: `There is no agent profile «${levels.asked}» on this Mac${profiles.length ? `; profiles: ${names.join(", ")}` : ""}.` };
      return this.settings(paseo, found, `${found.name} (asked for)`, levels.mode, levels.effort, levels.macEffort, model, names);
    }
    for (const [name, where] of [
      [levels.task, "the task's"],
      [levels.space, "the space's"],
    ] as const) {
      const found = name ? find(name) : undefined;
      if (found) return this.settings(paseo, found, `${found.name} (${where})`, levels.mode, levels.effort, levels.macEffort, model, names);
    }
    if (!firstProvider) return { ok: false, error: "No agent provider is available on this Mac." };
    const skipped = [levels.task, levels.space].filter(Boolean);
    const note = skipped.length ? `; ${skipped.map((n) => `«${n}»`).join(" and ")} not on this Mac` : "";
    // Only where no profile applies: a profile a person set names its own model and effort.
    const policy = firstProvider === POLICY_PROVIDER ? levels.policy : undefined;
    return this.settings(
      paseo,
      { id: "", name: firstProvider, provider: firstProvider },
      `${firstProvider} with its defaults (this Mac's${note})`,
      levels.mode,
      levels.effort,
      levels.macEffort,
      { ...model, policy },
      names,
    );
  }

  /**
   * The modes of this Mac's first available provider and the efforts of its default model, for picking
   * this Mac's start defaults. A profile may name another provider or model: its start then says
   * whether the default applies there.
   */
  async options(paseo: PaseoApi): Promise<{ provider: string; modes: { id: string; label: string; skips: boolean }[]; efforts: { id: string; label: string; model_default: boolean }[] }> {
    const { firstProvider } = await this.load(paseo);
    if (!firstProvider) throw new Error("No agent provider is available on this Mac.");
    const models = await this.listModels(paseo, firstProvider);
    const model = models.find((m) => m.isDefault) ?? models.find((m) => m.isSelectable !== false);
    const snapshot = await paseo.providers.snapshot();
    const entries = snapshot.entries?.length ? snapshot.entries : (snapshot.compactSnapshot?.entries ?? []);
    const entry = entries.find((e) => e.provider === firstProvider);
    const declared = model?.defaultThinkingOptionId ?? model?.thinkingOptions?.find((o) => o.isDefault)?.id;
    return {
      provider: model ? `${firstProvider}/${model.id}` : firstProvider,
      modes: (entry?.modes ?? []).map((m) => ({ id: m.id, label: m.label || m.id, skips: m.colorTier === DANGEROUS_TIER })),
      efforts: (model?.thinkingOptions ?? []).map((o) => ({ id: o.id, label: o.label || o.id, model_default: o.id === declared })),
    };
  }

  /** The provider's models, read again after a minute. */
  private async listModels(paseo: PaseoApi, provider: string): Promise<ModelEntry[]> {
    const cached = this.models.get(provider);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.models;
    const listed = await paseo.providers.listModels(provider);
    const models = (listed.models ?? []) as ModelEntry[];
    this.models.set(provider, { at: this.now(), models });
    return models;
  }

  /**
   * `agents.create` takes `provider/model`; a profile without a model, and this Mac's default, use
   * the provider's default model.
   */
  private async settings(
    paseo: PaseoApi,
    profile: AgentProfile,
    label: string,
    wanted: { asked?: string; space?: string; mac?: MacMode } = {},
    effortAsked?: string,
    macEffort?: string,
    modelWanted: { asked?: string; policy?: PolicyPick } = {},
    profiles: string[] = [],
  ): Promise<ProfileChoice> {
    const picked = await this.model(paseo, profile, modelWanted);
    if ("error" in picked) return { ok: false, error: picked.error };
    const { id: model, models } = picked;
    const mode = await this.mode(paseo, profile, wanted);
    if ("error" in mode) return { ok: false, error: mode.error };
    const effort = this.effort(profile, model, models, effortAsked, macEffort, picked.effort);
    if ("error" in effort) return { ok: false, error: effort.error };
    return {
      ok: true,
      settings: {
        provider: `${profile.provider}/${model}`,
        ...(mode.id ? { modeId: mode.id } : {}),
        ...(effort.id ? { thinkingOptionId: effort.id } : {}),
        ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
        label,
        mode: mode.text,
        modes: mode.modes,
        asks: mode.asks,
        effort: effort.text,
        efforts: effort.efforts,
        modelId: model,
        model: picked.text,
        models: picked.options,
        profiles,
      },
    };
  }

  /**
   * The model picked at the start (it must be one of the provider's), else the profile's, else the
   * policy's when Paseo offers it here, else the provider's default. Without a model named, the start
   * needs the list and fails as before when it cannot be read; a picked or profile model is passed
   * unchecked then, and said so.
   */
  private async model(
    paseo: PaseoApi,
    profile: AgentProfile,
    wanted: { asked?: string; policy?: PolicyPick },
  ): Promise<{ id: string; text: string; options: ModelOption[]; models: ModelEntry[] | { error: string }; effort?: { id: string; where: string } } | { error: string }> {
    const named = wanted.asked ?? profile.model;
    const models: ModelEntry[] | { error: string } = named
      ? await this.listModels(paseo, profile.provider).catch((error) => ({ error: String((error as Error)?.message ?? error) }))
      : await this.listModels(paseo, profile.provider);
    const listed = Array.isArray(models) ? models : [];
    const usable = listed.filter((m) => m.isSelectable !== false);
    const listedAs = (id: string) => listed.find((m) => m.id === id || m.aliases?.includes(id));
    const entryOf = (id: string) => usable.find((m) => m.id === id || m.aliases?.includes(id));
    // As before the policy: the declared default even when Paseo marks it not selectable.
    const fallback = listed.find((m) => m.isDefault) ?? usable[0];
    const spoken = (id: string, where: string) => {
      const label = listedAs(id)?.label;
      return label && label !== id ? `${label} (${id}, ${where})` : `${id} (${where})`;
    };
    // Few chips, not the provider's whole catalogue: what the policy picks from, the default and the chosen one.
    const options = (chosen: string): ModelOption[] => {
      const ids = [...new Set([chosen, ...(profile.provider === POLICY_PROVIDER ? Object.values(TIER_SETTINGS).map((tier) => tier.model) : []), fallback?.id])];
      return ids.flatMap((id) => {
        const entry = id ? (id === chosen || id === fallback?.id ? listedAs(id) : entryOf(id)) : undefined;
        return entry ? [{ id: entry.id, label: entry.label || entry.id }] : [];
      });
    };
    const answer = (id: string, text: string, effort?: { id: string; where: string }) => ({ id, text, options: options(id), models, ...(effort ? { effort } : {}) });
    if (wanted.asked) {
      // Picked from this provider's list in the confirmation; anything else is refused, not guessed.
      if (Array.isArray(models) && !entryOf(wanted.asked)) {
        return { error: `${profile.provider} offers no model «${wanted.asked}» on this Mac; its models: ${usable.map((m) => m.id).join(", ")}.` };
      }
      return answer(wanted.asked, Array.isArray(models) ? spoken(wanted.asked, "picked") : `${wanted.asked} (picked; the models could not be read: ${models.error})`);
    }
    if (profile.model) {
      return answer(profile.model, Array.isArray(models) ? spoken(profile.model, "the profile's") : `${profile.model} (the profile's)`);
    }
    if (!fallback) return { error: `The provider ${profile.provider} offers no model on this Mac.` };
    const policy = wanted.policy;
    if (policy) {
      const entry = entryOf(policy.model);
      if (entry) return answer(entry.id, spoken(entry.id, `picked for the task: ${policy.reason}`), { id: policy.effort, where: "picked for the task" });
      return answer(fallback.id, `${spoken(fallback.id, "the provider's default")}; the task's pick ${policy.model} is not offered on this Mac`);
    }
    return answer(fallback.id, spoken(fallback.id, "the provider's default"));
  }

  /**
   * The effort picked at the start (it must be one of the model's), else the profile's, else this
   * Mac's default when the model has it, else the model's declared default; none when the model
   * declares none. A list of models that cannot be read passes the picked or the profile's effort as
   * it is, else none, and says so.
   */
  private effort(
    profile: AgentProfile,
    model: string,
    models: ModelEntry[] | { error: string },
    asked: string | undefined,
    mac?: string,
    policy?: { id: string; where: string },
  ): { id?: string; text: string; efforts: EffortOption[] } | { error: string } {
    if (!Array.isArray(models)) {
      if (asked) return { id: asked, text: `${asked} (picked)`, efforts: [] };
      if (profile.thinkingOptionId) return { id: profile.thinkingOptionId, text: `${profile.thinkingOptionId} (the profile's)`, efforts: [] };
      // Unchecked, a Mac default the model lacks could fail every start: the provider's own then, said.
      return { text: `the provider's own; its models could not be read: ${models.error}${mac ? `; ${MAC_DEFAULT} «${mac}» is not used unchecked` : ""}`, efforts: [] };
    }
    const entry = models.find((m) => m.id === model || m.aliases?.includes(model));
    const efforts: EffortOption[] = (entry?.thinkingOptions ?? []).map((o) => ({ id: o.id, label: o.label || o.id }));
    const labelOf = (id: string) => efforts.find((e) => e.id === id)?.label;
    const spoken = (id: string, where: string) => (labelOf(id) && labelOf(id) !== id ? `${labelOf(id)} (${id}, ${where})` : `${id} (${where})`);
    if (asked) {
      // Picked from this model's list in the confirmation; anything else is refused, not guessed.
      if (efforts.length && !efforts.some((e) => e.id === asked)) {
        return { error: `${model} has no effort «${asked}»; its efforts: ${efforts.map((e) => e.id).join(", ")}.` };
      }
      return { id: asked, text: spoken(asked, "picked"), efforts };
    }
    if (profile.thinkingOptionId) return { id: profile.thinkingOptionId, text: spoken(profile.thinkingOptionId, "the profile's"), efforts };
    // The policy picked the model with its effort: it goes before this Mac's default, which is one for every task.
    if (policy && efforts.some((e) => e.id === policy.id)) return { id: policy.id, text: spoken(policy.id, policy.where), efforts };
    const unpicked = policy ? `; the task's pick «${policy.id}» is not one of ${model}'s efforts` : "";
    if (mac && efforts.some((e) => e.id === mac)) return { id: mac, text: `${spoken(mac, MAC_DEFAULT)}${unpicked}`, efforts };
    // This Mac's default is said where it does not apply: the effort shown is never a silent swap.
    const missed = `${unpicked}${mac ? `; ${MAC_DEFAULT} «${mac}» is not one of ${model}'s efforts` : ""}`;
    const declared = entry?.defaultThinkingOptionId ?? entry?.thinkingOptions?.find((o) => o.isDefault)?.id;
    if (declared) return { id: declared, text: `${spoken(declared, "the model's default")}${missed}`, efforts };
    return { text: `${entry ? `the provider's own; ${model} declares no default effort` : `the provider's own; Paseo lists no model ${model}`}${missed}`, efforts };
  }

  /**
   * The mode picked at the start (it must be one of the provider's), else the profile's, else the
   * space's when the provider has it, else the provider's declared default; none when it declares
   * none. Mode ids mean different things per provider (Codex's `auto` is its "Default Permissions"),
   * so nothing is assumed. A snapshot that cannot be read passes the picked or the profile's mode
   * as it is, else none, and says so.
   */
  private async mode(
    paseo: PaseoApi,
    profile: AgentProfile,
    wanted: { asked?: string; space?: string; mac?: MacMode },
  ): Promise<{ id?: string; text: string; modes: ModeOption[]; asks: boolean } | { error: string }> {
    let entries;
    try {
      // A provider still loading has not declared its modes yet: such a snapshot is read again next time.
      const fresh = this.snapshot && this.now() - this.snapshot.at < CACHE_MS && !this.snapshot.entries.some((e) => e.status === "loading");
      if (!fresh) {
        const snapshot = await paseo.providers.snapshot();
        // The protocol lets the daemon send the compact form beside (or instead of) the full entries.
        const listed = snapshot.entries?.length ? snapshot.entries : (snapshot.compactSnapshot?.entries ?? []);
        this.snapshot = { at: this.now(), entries: listed };
      }
      entries = this.snapshot!.entries;
    } catch (error) {
      const unread = { modes: [], asks: false };
      if (wanted.asked) return { id: wanted.asked, text: `${wanted.asked} (picked)`, ...unread };
      if (profile.modeId) return { id: profile.modeId, text: `${profile.modeId} (the profile's)`, ...unread };
      // Unchecked, a Mac default could be one that skips permission prompts: the provider's own then.
      const macUnused = wanted.mac?.provider === profile.provider ? `; ${MAC_DEFAULT} «${wanted.mac.id}» is not used unchecked` : "";
      return { text: `the provider's own; its modes could not be read: ${String((error as Error)?.message ?? error)}${macUnused}`, ...unread };
    }
    const entry = entries.find((e) => e.provider === profile.provider);
    const modes: ModeOption[] = (entry?.modes ?? []).map((m) => ({ id: m.id, label: m.label || m.id, asks: ASKING_TIERS.has(m.colorTier ?? "") }));
    const has = (id: string) => modes.some((m) => m.id === id);
    const dangerous = (id: string) => entry?.modes?.find((m) => m.id === id)?.colorTier === DANGEROUS_TIER;
    const labelOf = (id: string) => modes.find((m) => m.id === id)?.label;
    const asks = (id: string | undefined) => Boolean(id && modes.find((m) => m.id === id)?.asks);
    const spoken = (id: string, where: string) => (labelOf(id) && labelOf(id) !== id ? `${labelOf(id)} (${id}, ${where})` : `${id} (${where})`);
    const chosen = (id: string, where: string) => ({ id, text: spoken(id, where), modes, asks: asks(id) });
    if (wanted.asked) {
      // Picked from this provider's list in the confirmation; anything else is refused, not guessed.
      if (modes.length && !has(wanted.asked)) return { error: `${profile.provider} has no mode «${wanted.asked}»; its modes: ${modes.map((m) => m.id).join(", ")}.` };
      return chosen(wanted.asked, "picked");
    }
    if (profile.modeId) return chosen(profile.modeId, "the profile's");
    // The space's mode is a wish for every provider: one that does not have it falls through, saying
    // so. One that skips permission prompts is never taken from space.yaml, which every collaborator
    // with push access writes along with the agent's first message; a person can still pick it here.
    const space = wanted.space;
    const skipped = !space
      ? ""
      : !has(space)
        ? `; the space's «${space}» is not one of ${profile.provider}'s modes`
        : dangerous(space)
          ? `; the space's «${space}» is not used, as it skips permission prompts: pick it here to use it`
          : "";
    if (space && has(space) && !dangerous(space)) return chosen(space, "the space's");
    // This Mac's default, set in Settings, under the same rule: a mode that skips permission prompts is
    // picked per start, never by default.
    // Set for one provider: another provider's mode of the same id may mean something else.
    const mac = wanted.mac?.provider === profile.provider ? wanted.mac.id : undefined;
    if (mac && has(mac) && !dangerous(mac)) {
      const picked = chosen(mac, MAC_DEFAULT);
      return { ...picked, text: `${picked.text}${skipped}` };
    }
    const macSkipped = !mac ? "" : !has(mac) ? `; ${MAC_DEFAULT} «${mac}» is not one of ${profile.provider}'s modes` : `; ${MAC_DEFAULT} «${mac}» is not used, as it skips permission prompts: pick it at the start to use it`;
    if (entry?.defaultModeId) {
      const picked = chosen(entry.defaultModeId, "the provider's default");
      return { ...picked, text: `${picked.text}${skipped}${macSkipped}` };
    }
    const none = { modes, asks: false };
    if (!entry) return { text: `the provider's own; Paseo lists no modes for ${profile.provider}${skipped}${macSkipped}`, ...none };
    if (entry.status === "loading") return { text: `the provider's own; Paseo is still loading ${profile.provider}'s modes${skipped}${macSkipped}`, ...none };
    return { text: `the provider's own; ${profile.provider} declares no default mode${skipped}${macSkipped}`, ...none };
  }
}
