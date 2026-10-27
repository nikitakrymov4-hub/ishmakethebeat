import type { Project, ScoreEvent } from "./schema";
import { seconds } from "./schema";
import { score, totalTicks } from "./score";

/** Retain the established tail for projects without explicit vocal events. */
export const TAIL_SECONDS = 4;
const clamp = (x: number, min: number, max: number) =>
  Math.max(min, Math.min(max, x));

/** Parallel vocal returns, estimated until feedback is below -80 dB relative to its input. */
export function eventTailSeconds(event: ScoreEvent, bpm: number): number {
  if (!event.vocal) return TAIL_SECONDS;
  const delay = event.effects?.delay;
  const reverb = event.effects?.reverb;
  let tail = 0;
  if (delay) {
    const wet = Math.max(
      delay.wet,
      ...(delay.automation ?? []).map((a) => a.wet),
    );
    if (wet > 0) {
      const interval = Math.min(
        3.95,
        (60 / bpm) * clamp(delay.division, 0.03125, 4),
      );
      const feedback = clamp(delay.feedback, 0, 0.67);
      const repeats =
        feedback > 0
          ? Math.max(
              0,
              Math.ceil(
                Math.log(0.0001 / clamp(wet, 0.0001, 0.9)) / Math.log(feedback),
              ),
            )
          : 0;
      tail = interval * (1 + repeats);
    }
  }
  if (reverb && reverb.wet > 0)
    tail = Math.max(
      tail,
      clamp(reverb.preDelay, 0, 1) + clamp(reverb.decay, 0.05, 12),
    );
  return tail;
}

/** Stored vocal placements determine alignment even when activity is disabled for an instrumental export. */
export function renderDurationSeconds(project: Project): number {
  let duration =
    seconds(totalTicks(project), project.settings.bpm) + TAIL_SECONDS;
  if (!project.vocalEvents?.length) return duration;
  const alignedProject: Project = {
    ...project,
    tagEnabled: true,
    voxEnabled: true,
    // Ignore choke for the common window: disabling a later trigger must not shorten the retained source.
    vocalEvents: project.vocalEvents.map((v) => ({
      ...v,
      enabled: true,
      overlap: "allow" as const,
    })),
  };
  for (const event of score(alignedProject, true)) {
    if (!event.vocal) continue;
    duration = Math.max(
      duration,
      seconds(event.tick + event.duration, project.settings.bpm) +
        eventTailSeconds(event, project.settings.bpm),
    );
  }
  return duration;
}

/** Omit sources before graph construction so their sends cannot appear in the instrumental return. */
export function withoutVocals(project: Project): Project {
  return {
    ...project,
    tagEnabled: false,
    voxEnabled: false,
    vocalEvents: project.vocalEvents?.map((v) => ({ ...v, enabled: false })),
  };
}
