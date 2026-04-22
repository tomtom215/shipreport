import type { DevQuarter, PRKind } from "./types.js";

export interface Narration {
  headline: string;
  collaboration: string;
  talkingPoints: string[];
}

export function headline(d: DevQuarter): string {
  if (d.prsByKind.feature >= 3 && d.shippedMilestones.length > 0) {
    return `Shipped ${d.shippedMilestones.length} milestone${plural(d.shippedMilestones.length)} across ${d.crossRepoCollaboration} service${plural(d.crossRepoCollaboration)}.`;
  }
  if (d.reviewsGiven >= 20) {
    return `Anchored team quality with ${d.reviewsGiven} code reviews while delivering ${d.prsMerged} PR${plural(d.prsMerged)}.`;
  }
  if (d.prsByKind.bugfix >= 5 && d.prsByKind.bugfix >= d.prsByKind.feature) {
    return `Closed out ${d.prsByKind.bugfix} bugs and stabilized ${d.crossRepoCollaboration} service${plural(d.crossRepoCollaboration)}.`;
  }
  if (d.prsMerged === 0) {
    return `No merged PRs in scanned repositories this quarter — see notes below.`;
  }
  return `Delivered ${d.prsMerged} merged PR${plural(d.prsMerged)} across ${d.crossRepoCollaboration} repo${plural(d.crossRepoCollaboration)}.`;
}

export function collaborationNote(d: DevQuarter): string {
  const parts: string[] = [];
  if (d.reviewsGiven > 0) {
    parts.push(
      `Provided ${d.reviewsGiven} code review${plural(d.reviewsGiven)} on teammates' pull requests`,
    );
  }
  if (d.crossRepoCollaboration > 1) {
    parts.push(
      `contributed across ${d.crossRepoCollaboration} different services (cross-team signal)`,
    );
  }
  if (d.linkedIssuesClosed.length > 0) {
    parts.push(
      `closed ${d.linkedIssuesClosed.length} linked issue${plural(d.linkedIssuesClosed.length)}`,
    );
  }
  if (parts.length === 0) {
    return "Primarily focused on individual delivery this quarter.";
  }
  return capitalize(parts.join("; ")) + ".";
}

export function talkingPoints(d: DevQuarter): string[] {
  const out: string[] = [];

  const dominant = dominantKind(d.prsByKind);
  if (dominant === "feature") {
    out.push(
      `Feature-heavy quarter (${d.prsByKind.feature} of ${d.prsMerged} merged PRs) — consider a customer-facing impact story for each milestone.`,
    );
  } else if (dominant === "bugfix") {
    out.push(
      `Reliability-focused quarter (${d.prsByKind.bugfix} fixes) — pair each fix with the incident or metric it improved.`,
    );
  } else if (dominant === "refactor") {
    out.push(
      `Investment quarter (${d.prsByKind.refactor} refactors) — quantify the debt paid down (build-time, test-time, incidents avoided).`,
    );
  } else if (dominant === "infra") {
    out.push(
      `Platform/infra quarter (${d.prsByKind.infra} merged) — frame impact in developer-hours saved or reliability improvements.`,
    );
  }

  if (d.reviewsGiven >= 15) {
    out.push(
      `Strong review leadership (${d.reviewsGiven} reviews given) — name the teammates they mentored.`,
    );
  }
  if (d.crossRepoCollaboration >= 3) {
    out.push(
      `Touched ${d.crossRepoCollaboration} services — call out any cross-team coordination they drove.`,
    );
  }
  if (d.shippedMilestones.length > 0) {
    out.push(
      `Milestones delivered: ${d.shippedMilestones.join(", ")} — link the launch comms if any.`,
    );
  }
  if (d.prsMerged === 0) {
    out.push(
      `No merged PRs in the scanned repositories — check whether the dev worked in repos outside the config, or was on leave.`,
    );
  }

  return out;
}

export function narrate(d: DevQuarter): Narration {
  return {
    headline: headline(d),
    collaboration: collaborationNote(d),
    talkingPoints: talkingPoints(d),
  };
}

function dominantKind(kinds: Record<PRKind, number>): PRKind {
  let best: PRKind = "other";
  let max = -1;
  for (const k of Object.keys(kinds) as PRKind[]) {
    if (kinds[k] > max) {
      max = kinds[k];
      best = k;
    }
  }
  return best;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
