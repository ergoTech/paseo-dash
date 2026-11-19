import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import { PLUGIN_NAME } from "../shared/edition.ts";
import { godModeSettingsRpc, godModeSettingsSetRpc } from "../shared/godmode.ts";
import { autopilotReadRpc, autopilotSetRpc, autopilotStartOptionsRpc, MAX_RUNNING_CAP, slotNote } from "../shared/ui.ts";
import { REFRESH_MS, type Styles } from "./common.tsx";
import { openSettings } from "./nav.ts";

type Theme = PluginHostProps["theme"];

/**
 * How runs start on this Mac: the autopilot's limit of runs at work (server/autopilot.ts), the runs
 * that hold its slots now, and whether ChatGPT reads a start back first. Shown in the top bar's
 * Settings dialog and in Settings → Paseo Dash; each control says what it reaches.
 */

const LIMITS = Array.from({ length: MAX_RUNNING_CAP }, (_, i) => String(i + 1));

export function RunSettings() {
  return (
    <>
      <AutopilotLimit />
      <StartWithoutAsking />
    </>
  );
}

function AutopilotLimit() {
  const read = useRpc(autopilotReadRpc);
  const write = useRpc(autopilotSetRpc);
  const queryClient = useQueryClient();
  // The key Live's autopilot section reads too: one change shows in both.
  const state = useQuery({ queryKey: ["dashboard", "autopilot"], queryFn: () => read({}), refetchInterval: REFRESH_MS });
  const saving = useMutation({
    mutationFn: (max_running: number) => write({ max_running }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard", "autopilot"] }),
  });
  const a = state.data;
  const error = a?.error || (saving.data && !saving.data.ok ? saving.data.error : "") || (saving.isError ? `Unknown whether it changed: ${String(saving.error)}` : "") || (state.isError ? `Could not read the autopilot: ${String(state.error)}` : "");
  const limit = saving.isPending ? saving.variables : a?.max_running;
  const holding = a?.runs.filter((r) => r.holds_place) ?? [];
  const idle = a?.runs.filter((r) => !r.holds_place) ?? [];
  return (
    <SettingsSection title="Autopilot">
      <SettingsCard>
        <SettingsSelect
          label="Runs at work at once"
          hint="This Mac, every space. The autopilot starts a task only while fewer runs hold a slot; a change counts at once and stays after a restart. A lower limit stops no run: the autopilot waits until enough of them end. Your own starts are not limited."
          value={limit && !a?.error ? String(limit) : ""}
          options={LIMITS.map((value) => ({ label: value, value }))}
          disabled={!a || Boolean(a.error) || saving.isPending}
          onValueChange={(value) => saving.mutate(Number(value))}
          error={error || null}
        />
        <SettingsRow
          label={a && !a.error ? `Slots in use: ${a.running} of ${a.max_running}` : "Slots in use"}
          hint="A run holds a slot while its agent is being started, works, asks for a permission, or waits for your reply in a task in progress. A stopped or failed agent holds none, though its task stays held until you release it; nor does a task in review, which waits for your acceptance."
        />
        {a?.limit.until ? <SettingsRow label="Starts wait for a usage limit" hint={`Until ${new Date(a.limit.until).toLocaleString()}: ${a.limit.source}`} /> : null}
        {[...holding, ...idle].map((run) => (
          <SettingsRow key={`${run.space}:${run.task}`} label={`${run.task} · ${run.title}`} hint={slotNote(run)} />
        ))}
      </SettingsCard>
      <StartDefaults />
    </SettingsSection>
  );
}

type StartChange = { start_new_tasks?: boolean; start_mode?: string; start_mode_provider?: string; start_effort?: string };

/**
 * This Mac's start defaults (server/autopilot.ts DEFAULT_START): whether a new ready task starts on its
 * own, and the mode and effort of every start that names none more specific. The lists are those of
 * this Mac's default provider and model; a start with another one says whether the default applies.
 */
function StartDefaults() {
  const read = useRpc(autopilotReadRpc);
  const write = useRpc(autopilotSetRpc);
  const readOptions = useRpc(autopilotStartOptionsRpc);
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["dashboard", "autopilot"], queryFn: () => read({}), refetchInterval: REFRESH_MS });
  const options = useQuery({ queryKey: ["dashboard", "autopilot", "start-options"], queryFn: () => readOptions({}) });
  const saving = useMutation({
    mutationFn: (change: StartChange) => write(change),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard", "autopilot"] }),
  });
  const a = state.data;
  const o = options.data;
  const pending = saving.isPending ? saving.variables : undefined;
  const start = a && !a.error ? { ...a.start, ...(pending?.start_new_tasks !== undefined ? { new_tasks: pending.start_new_tasks } : {}), ...(pending?.start_mode ? { mode: pending.start_mode } : {}), ...(pending?.start_effort ? { effort: pending.start_effort } : {}) } : undefined;
  const error = (saving.data && !saving.data.ok ? saving.data.error : "") || (saving.isError ? `Unknown whether it changed: ${String(saving.error)}` : "");
  const listError = o?.error || (options.isError ? String(options.error) : "");
  // A stored id the provider no longer lists stays shown, so the setting never looks changed when it is not.
  const withCurrent = <T extends { id: string; label: string }>(list: T[], current: string | undefined) =>
    current && !list.some((x) => x.id === current) ? [...list.map((x) => ({ id: x.id, label: x.label })), { id: current, label: `${current} (not offered by ${o?.provider || "the default provider"})` }] : list;
  const provider = o?.provider.split("/")[0] ?? "";
  // The stored mode is one provider's: shown only with that provider's list.
  const modes = start?.mode_provider === provider ? withCurrent((o?.modes ?? []).filter((m) => !m.skips), start.mode) : (o?.modes ?? []).filter((m) => !m.skips);
  const efforts = withCurrent((o?.efforts ?? []).map((e) => ({ id: e.id, label: e.model_default ? `${e.label} (the model's default)` : e.label })), start?.effort);
  const disabled = !start || saving.isPending;
  return (
    <SettingsCard>
      <SettingsSwitch
        label="Start new ready tasks"
        hint="A task created in To Do, with nothing to wait for and its project on this Mac, goes to the autopilot and starts once, as soon as a slot is free. Not a task created as To Do only, a blocked one, one whose brief lists open questions, or one labeled as a person's work. A task ChatGPT creates starts so only while ChatGPT may start without asking; otherwise it asks you through the start's read-back."
        value={start?.new_tasks === true}
        disabled={disabled}
        onValueChange={(value) => saving.mutate({ start_new_tasks: value })}
        error={error || null}
      />
      <SettingsSelect
        label="Mode of every start"
        hint={`Unless the task's or space's agent profile, or the space, names one, or you pick another when starting. Modes that skip permission prompts are picked per start only.${provider ? ` Modes of ${provider}; agents of another provider start in that provider's default.` : ""}`}
        value={start && start.mode_provider === provider ? start.mode : ""}
        options={modes.map((m) => ({ label: m.label, value: m.id }))}
        disabled={disabled || !modes.length || !provider}
        onValueChange={(value) => saving.mutate({ start_mode: value, start_mode_provider: provider })}
        error={listError || null}
      />
      <SettingsSelect
        label="Effort of every start"
        hint={`Passed to the agent explicitly, instead of the model's default, unless the agent profile names one or you pick another when starting. A model without it runs with its own default, and the start says so.${o?.provider ? ` Efforts of ${o.provider}.` : ""}`}
        value={start?.effort ?? ""}
        options={efforts.map((e) => ({ label: e.label, value: e.id }))}
        disabled={disabled || !efforts.length}
        onValueChange={(value) => saving.mutate({ start_effort: value })}
        error={listError || null}
      />
    </SettingsCard>
  );
}

/**
 * Whether ChatGPT (through God Mode) may start a task without reading the start back first
 * (06-god-mode.md, Starting without asking). The agent's permission mode is not set here.
 */
function StartWithoutAsking() {
  const read = useRpc(godModeSettingsRpc);
  const write = useRpc(godModeSettingsSetRpc);
  const settings = useQuery({ queryKey: ["dashboard", "godmode", "settings"], queryFn: () => read({}) });
  const saving = useMutation({ mutationFn: (start_without_asking: boolean) => write({ start_without_asking }), onSettled: () => settings.refetch() });
  const error = settings.data?.error || (saving.data && !saving.data.ok ? saving.data.error : "") || (saving.isError ? String(saving.error) : "");
  return (
    <SettingsSection title="Starts asked through ChatGPT (God Mode)">
      <SettingsCard>
        <SettingsSwitch
          label="Start tasks without asking"
          hint="Only starts ChatGPT makes through God Mode on this Mac; the start dialog here and the autopilot do not change. ChatGPT starts a todo task as soon as you ask, without reading the start back first, also when someone else changed its instructions since you saw them; it tells you after the start. The agent's permission mode comes from its profile or provider, not from this switch."
          value={saving.isPending || (saving.isSuccess && settings.isFetching) ? Boolean(saving.variables) : settings.data?.start_without_asking === true}
          disabled={!settings.data || saving.isPending}
          onValueChange={(value) => saving.mutate(value)}
          error={error || null}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** The top bar's "Settings": a dialog with how runs start here, and the way to every other setting. */
export function SettingsButton({ theme, styles, compact }: { theme: Theme; styles: Styles; compact: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings: autopilot limit and how tasks start"
        onPress={() => setOpen(true)}
        hitSlop={6}
        style={[styles.ghost, styles.row, { gap: 6, paddingHorizontal: compact ? 9 : 12 }]}
      >
        <Icon name="Settings" size={15} color={theme.colors.foregroundMuted} />
        {compact ? null : <Text style={styles.ghostText}>Settings</Text>}
      </Pressable>
      {open ? (
        <Modal title="Settings" open onOpenChange={(next) => (next ? undefined : setOpen(false))}>
          <Modal.Content>
            <RunSettings />
            <SettingsCard>
              <SettingsAction
                label={`Every ${PLUGIN_NAME} setting`}
                hint="Plan repositories, issues, Laconote, agents' plan tools"
                actionLabel="Open"
                onPress={() => {
                  setOpen(false);
                  openSettings();
                }}
              />
            </SettingsCard>
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}
