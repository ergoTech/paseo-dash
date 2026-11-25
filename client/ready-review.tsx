import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { REVIEW_COVERAGE, readyReviewRpc } from "../shared/api.ts";
import { Button, Chip, isWebUrl, ItemRow, REFRESH_MS, Section, type Styles } from "./common.tsx";
import { useShow } from "./nav.ts";

type Theme = PluginScreenProps["theme"];
type Review = RpcOutput<typeof readyReviewRpc>;
type Card = Review["tasks"][number];
type Coverage = (typeof REVIEW_COVERAGE)[number];

const COVERAGE_TITLES: Record<Coverage, string> = {
  confirmed: "Confirmed",
  partial: "Partly covered",
  possible: "Possible match",
  none: "Nothing found",
};

const LEFT_TITLES: Record<Card["left"], string> = {
  accept: "left: accept it",
  qa: "left: QA",
  fix: "left: fix what QA failed",
  check: "left: check the work",
  compare: "left: compare",
  implementation: "left: implementation",
};

/** Cards one read lists, the most the contract allows. */
const CARDS = 50;

function PrLine({ pr, styles, theme }: { pr: { pr: string; url: string; state: string; tie?: string }; styles: Styles; theme: Theme }) {
  const text = `${pr.pr} ${pr.state}`;
  return (
    <View style={[styles.row, { flexWrap: "wrap", gap: 4 }]}>
      {isWebUrl(pr.url) ? (
        <ExternalLink href={pr.url}>
          <Text style={[styles.muted, { color: theme.colors.accent }]}>{text}</Text>
        </ExternalLink>
      ) : (
        <Text style={styles.muted}>{text}</Text>
      )}
      {pr.tie ? <Text style={[styles.muted, { flexShrink: 1 }]}>{pr.tie}</Text> : null}
    </View>
  );
}

/** One card: its coverage and next step always, its evidence on request. */
function ReviewCard({ card: listed, styles, theme }: { card: Card; styles: Styles; theme: Theme }) {
  const read = useRpc(readyReviewRpc);
  const toast = useToast();
  const show = useShow();
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  // A read of this one card asks its forge now; it stands until the list is read anew.
  const [fresh, setFresh] = useState<{ of: Card; card: Card }>();
  const card = fresh?.of === listed ? fresh.card : listed;
  const readNow = async () => {
    setBusy(true);
    try {
      const answer = await read({ task: card.id });
      const found = answer.tasks[0];
      if (found) setFresh({ of: listed, card: found });
      else toast.show(answer.error || answer.note);
    } catch (failure) {
      toast.error(`Could not read ${card.id}: ${String((failure as Error)?.message ?? failure)}`);
    } finally {
      setBusy(false);
    }
  };
  const { done, total } = card.acceptance;
  return (
    <View style={[styles.card, { gap: 4 }]}>
      <ItemRow
        glyph={card.coverage === "confirmed" ? "done" : card.coverage === "none" ? (card.waits_for.length ? "blocked" : "todo") : "needs_you"}
        title={card.title}
        note={[card.id, card.project, COVERAGE_TITLES[card.coverage], card.basis === "similar" ? "by text only" : "", LEFT_TITLES[card.left], total ? `${done}/${total} criteria` : "no criteria"].filter(Boolean).join(" · ")}
        onPress={() => show.task(card.id, { title: card.title })}
        theme={theme}
        styles={styles}
      />
      <Text style={styles.text}>{card.next}</Text>
      {card.incomplete.length ? <Text style={styles.error}>{`Incomplete data: ${card.incomplete.join("; ")}`}</Text> : null}
      {details ? (
        <View style={{ gap: 4 }}>
          {card.evidence.map((line) => (
            <Text key={line} style={styles.muted}>{`• ${line}`}</Text>
          ))}
          {card.prs.map((pr) => (
            <PrLine key={pr.url} pr={pr} styles={styles} theme={theme} />
          ))}
          {card.related.map((related) => (
            <View key={related.id} style={{ gap: 2 }}>
              <ItemRow
                glyph={related.status === "done" ? "done" : "elsewhere"}
                title={related.title}
                note={[related.id, related.status, ...related.signals, related.matched ? `${related.matched} open line(s) alike` : ""].filter(Boolean).join(" · ")}
                onPress={() => show.task(related.id, { title: related.title })}
                theme={theme}
                styles={styles}
              />
              {related.prs.map((pr) => (
                <PrLine key={pr.url} pr={pr} styles={styles} theme={theme} />
              ))}
              {related.matches.map((match) => (
                <Text key={match.open} style={styles.muted}>{`Open here: ${match.open}\nTicked there: ${match.theirs}`}</Text>
              ))}
            </View>
          ))}
          {card.open.length ? <Text style={styles.muted}>{`Open criteria:\n${card.open.map((line) => `- ${line}`).join("\n")}`}</Text> : null}
          {total - done > card.open.length ? <Text style={styles.muted}>{`${total - done - card.open.length} more open on the task`}</Text> : null}
          {card.waits_for.length ? <Text style={styles.muted}>{`Waits for ${card.waits_for.join(", ")}`}</Text> : null}
          <Text style={styles.muted}>{card.read_at ? `PR/MRs read ${new Date(card.read_at).toLocaleString()}` : "PR/MRs not read yet"}</Text>
        </View>
      ) : null}
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button label={details ? "Hide evidence" : "Evidence"} accessibilityLabel={`${details ? "Hide" : "Show"} the evidence of ${card.id}`} ghost onPress={() => setDetails(!details)} styles={styles} />
        {details ? <Button label={busy ? "Reading…" : "Read its PR/MR now"} ghost disabled={busy} onPress={() => void readNow()} styles={styles} /> : null}
      </View>
    </View>
  );
}

/**
 * Live's "Review before starting": per open card what covers it already and the next step, and which
 * tasks hold the most others back. Read only: a row opens the task, whose screen starts and accepts.
 */
export function ReadyReviewSection({ space, styles, theme }: { space?: string; styles: Styles; theme: Theme }) {
  const read = useRpc(readyReviewRpc);
  const show = useShow();
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState("");
  const [coverage, setCoverage] = useState<Coverage | "">("");
  const query = useQuery({
    queryKey: ["dashboard", "ready-review", space ?? "", project],
    queryFn: () => read({ space: space || undefined, project: project || undefined, limit: CARDS }),
    enabled: open,
    refetchInterval: REFRESH_MS,
  });
  const r = query.data;
  const cards = r?.tasks.filter((card) => !coverage || card.coverage === coverage) ?? [];
  return (
    <Section title="Review before starting" styles={styles} trailing={<Button label={open ? "Hide" : "Review"} accessibilityLabel={open ? "Hide the review" : "Review the open cards before starting"} ghost onPress={() => setOpen(!open)} styles={styles} />}>
      {!open ? <Text style={styles.muted}>What is covered already, what is left, and which task holds the others back. Changes nothing.</Text> : null}
      {open && query.isPending ? <Text style={styles.muted}>Reading…</Text> : null}
      {open && query.isError ? <Text style={styles.error}>{`Could not read the review: ${String((query.error as Error)?.message ?? query.error)}`}</Text> : null}
      {open && r ? (
        <View style={{ gap: 8 }}>
          {r.error ? <Text style={styles.error}>{r.error}</Text> : null}
          {r.projects.length > 1 || project ? (
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              <Chip label="All projects" active={!project} onPress={() => setProject("")} styles={styles} />
              {(r.projects.length ? r.projects : [project]).map((key) => (
                <Chip key={key} label={key} active={project === key} onPress={() => setProject(key)} styles={styles} />
              ))}
            </View>
          ) : null}
          <Text style={styles.muted}>{r.note}</Text>
          {r.roots.length ? <Text style={styles.text}>Holding other cards back:</Text> : null}
          {r.roots.map((root) => (
            <ItemRow
              key={root.id}
              glyph="blocked"
              title={`${root.title} · holds ${root.blocks}`}
              note={[root.id, root.status, root.next].filter(Boolean).join(" · ")}
              onPress={root.status === "missing" ? undefined : () => show.task(root.id, { title: root.title })}
              theme={theme}
              styles={styles}
            />
          ))}
          {r.roots_total > r.roots.length ? <Text style={styles.muted}>{`${r.roots_total - r.roots.length} more tasks hold others back`}</Text> : null}
          <View style={[styles.row, { flexWrap: "wrap" }]}>
            {/* The chosen filter stays listed at zero, so it can always be cleared. */}
            {REVIEW_COVERAGE.filter((key) => (r.counts[key] ?? 0) > 0 || key === coverage).map((key) => (
              <Chip key={key} label={`${COVERAGE_TITLES[key]} · ${r.counts[key] ?? 0}`} active={coverage === key} onPress={() => setCoverage(coverage === key ? "" : key)} styles={styles} />
            ))}
          </View>
          {coverage && !cards.length ? <Text style={styles.muted}>None of the listed cards: clear the filter, or narrow by project.</Text> : null}
          {cards.map((card) => (
            <ReviewCard key={card.id} card={card} styles={styles} theme={theme} />
          ))}
          {r.total > r.tasks.length ? <Text style={styles.muted}>{`The first ${r.tasks.length} of ${r.total} cards, covered ones first: narrow by project for the rest.`}</Text> : null}
        </View>
      ) : null}
    </Section>
  );
}
