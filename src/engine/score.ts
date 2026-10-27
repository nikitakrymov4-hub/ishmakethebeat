import { auraSectionNotes } from "./aura-writing";
import { BAR, LOOP_TICKS, PPQ, isDrum, seconds } from "./schema";
import type { Project, ScoreEvent, Section, Role, VocalEvent } from "./schema";
export const totalTicks = (p: Project) =>
  p.arrangement ? p.sections.reduce((n, s) => n + s.bars * BAR, 0) : LOOP_TICKS;
export interface VocalEventIssue {
  eventId: string;
  message: string;
}

/** Keep unresolved placements in the project so the editor can repair them. */
export function vocalEventIssues(p: Project): VocalEventIssue[] {
  const issues: VocalEventIssue[] = [];
  const arrangementTicks = p.sections.reduce((n, s) => n + s.bars * BAR, 0);
  for (const v of p.vocalEvents ?? []) {
    const issue = (message: string) => issues.push({ eventId: v.id, message });
    const asset = p.assets.find((a) => a.id === v.assetId);
    if (!asset) issue(`Missing audio asset for ${v.name}.`);
    else if (
      asset.duration !== undefined &&
      v.sourceOffset + v.sourceDuration >
        asset.duration + 1 / (asset.sampleRate || 44100)
    )
      issue(`Source trim exceeds the audio duration for ${v.name}.`);
    if (
      v.provenance.processing &&
      !p.assets.some((a) => a.id === v.provenance.processing!.sourceAssetId)
    )
      issue(`Missing original processing source for ${v.name}.`);
    let position = v.placement.tick;
    let timeline = p.arrangement
      ? arrangementTicks
      : Math.max(LOOP_TICKS, arrangementTicks);
    if (v.placement.kind === "section") {
      const sectionId = v.placement.sectionId;
      const index = p.sections.findIndex((s) => s.id === sectionId);
      if (index < 0) {
        issue(
          `Section for ${v.name} no longer exists; choose a section or absolute position.`,
        );
        continue;
      }
      const section = p.sections[index];
      if (v.placement.tick >= section.bars * BAR)
        issue(`Position for ${v.name} is outside its section.`);
      position += p.sections
        .slice(0, index)
        .reduce((n, s) => n + s.bars * BAR, 0);
      timeline = arrangementTicks;
    }
    if (
      position + (v.repeats?.count ?? 0) * (v.repeats?.intervalTicks ?? 0) >=
      timeline
    )
      issue(`Position or repeat for ${v.name} starts outside the arrangement.`);
  }
  return issues;
}

/** Editing migration; untouched legacy projects continue through their original playback path. */
export function migrateLegacyTag(p: Project): VocalEvent[] {
  if (p.vocalEvents !== undefined) return p.vocalEvents;
  const asset = p.assets.find((a) => a.id === p.tagAsset);
  if (!asset || asset.trimEnd <= asset.trimStart) return [];
  return [
    {
      id: "legacy-tag",
      name: asset.name,
      assetId: asset.id,
      role: "tag",
      enabled: true,
      placement: { kind: "absolute", tick: 0 },
      duration: BAR * 2,
      sourceOffset: asset.trimStart,
      sourceDuration: asset.trimEnd - asset.trimStart,
      gain: 0.6 * 0.7,
      pan: 0,
      pitch: -asset.tuning / 100,
      reverse: false,
      mode: asset.envelopeMode ?? "gated",
      fadeIn: asset.envelope?.attack ?? 0.00045,
      fadeOut: asset.envelope?.release ?? 0.004,
      overlap: "allow",
      provenance: {
        sourceName: asset.originalFilename ?? asset.name,
        sourceHash: asset.hash ?? "",
        creator: "User supplied",
        credit: asset.license,
      },
    },
  ];
}
function presence(
  section: Section,
  role: Role,
  localBar: number,
  planned = false,
): boolean {
  if (section.kind === "intro")
    return (
      ["melody", "pad", "keys", "pedal"].includes(role) ||
      (localBar >= 2 && role === "hat")
    );
  if (section.kind === "outro")
    return ["melody", "pad", "answer", "keys", "pedal"].includes(role);
  if (section.kind === "break")
    return (
      ["pad", "answer", "bridge", "pedal", "perc"].includes(role) ||
      (localBar >= section.bars - 2 && role === "clap")
    );
  if (section.kind === "verse")
    return (
      role !== "answer" &&
      role !== "pedal" &&
      !(role === "pad" && localBar % 8 >= 4) &&
      !(localBar % 8 === 7 && ["kick", "open"].includes(role))
    );
  return planned || !(localBar % 8 === 7 && role === "bass");
}
export function score(p: Project, includeMuted = false): ScoreEvent[] {
  const c = p.candidates[p.selected],
    hasSolo = c.tracks.some((t) => t.solo),
    sections = p.arrangement
      ? p.sections
      : [{ id: "loop", name: "Loop", bars: 8, kind: "hook" } as Section];
  let offset = 0;
  const events: ScoreEvent[] = [];
  for (const sec of sections) {
    const authored =
      p.auraOriginal && p.arrangement
        ? new Map(c.tracks.map((t) => [t.id, auraSectionNotes(p, c, t, sec)]))
        : undefined;
    for (let bar = 0; bar < sec.bars; bar++)
      for (const t of c.tracks) {
        if (
          !authored &&
          p.arrangement &&
          p.settings.profile === "culture" &&
          sec.kind === "outro" &&
          bar === sec.bars - 1
        )
          continue;
        if (!includeMuted && (t.mute || (hasSolo && !t.solo))) continue;
        if (
          !authored &&
          p.arrangement &&
          !presence(
            sec,
            t.id,
            bar,
            c.recipe?.performance?.planned ?? !!c.phrasePlan,
          )
        )
          continue;
        for (const n of authored?.get(t.id) ?? t.notes) {
          if (Math.floor(n.tick / BAR) !== (authored ? bar : bar % 8)) continue;
          // Version-gated performance variation: old projects play unchanged.
          // Never rewrite a locked track or transpose it over unrelated harmony.
          const develop =
            !authored &&
            p.arrangement &&
            !t.locked &&
            p.sourceKind !== "supplied-loop" &&
            (c.recipe?.performance?.developed ??
              c.recipe?.composition?.version === "culture-plan-2");
          const lateCycle = Math.floor(bar / 8) % 2 === 1;
          if (
            develop &&
            sec.kind === "verse" &&
            lateCycle &&
            ["hat", "perc"].includes(t.id) &&
            n.tick % (PPQ * 2) !== 0
          )
            continue;
          if (
            develop &&
            ["hook", "return"].includes(sec.kind) &&
            bar === sec.bars - 1 &&
            n.tick % BAR >= BAR - PPQ &&
            ["bass", "kick", "hat", "open", "perc"].includes(t.id)
          )
            continue;
          const response =
            develop &&
            lateCycle &&
            t.id === "melody" &&
            ["hook", "return"].includes(sec.kind) &&
            n.tick % (BAR * 2) >= BAR;
          const verseGate =
            develop && sec.kind === "verse" && t.id === "melody";
          const tick = offset + bar * BAR + (n.tick % BAR),
            end = offset + sec.bars * BAR;
          const filtered =
            p.arrangement && ["intro", "outro"].includes(sec.kind);
          const gain = filtered ? 0.7 : 1;
          events.push({
            ...n,
            pitch: Math.max(
              0,
              Math.min(127, n.pitch + (t.register ?? 0) + (response ? 12 : 0)),
            ),
            glide: n.glide
              ? { ...n.glide, to: n.glide.to + (t.register ?? 0) }
              : undefined,
            id: `${sec.id}-${bar}-${n.id}`,
            tick,
            duration: Math.max(
              15,
              Math.min(
                verseGate ? Math.round(n.duration * 0.7) : n.duration,
                end - tick,
              ),
            ),
            velocity: n.velocity * (verseGate ? 0.9 : response ? 0.92 : 1),
            role: t.id,
            instrument: t.instrument,
            gain: t.volume * gain,
            pan: t.id === "bass" ? 0 : t.pan,
            filter: filtered ? 0.42 : 1,
            effects: t.effects,
            effectTick: n.tick,
          });
        }
      }
    if (
      !authored &&
      p.arrangement &&
      p.settings.profile === "culture" &&
      p.sourceKind !== "supplied-loop" &&
      sec.kind === "outro"
    ) {
      for (const role of ["melody", "pad"] as const) {
        const t = c.tracks.find((t) => t.id === role)!;
        if (!includeMuted && (t.mute || (hasSolo && !t.solo))) continue;
        const pitches =
          role === "melody" ? [60 + p.settings.key] : c.harmony[0].pitches;
        for (const pitch of pitches)
          events.push({
            id: `${sec.id}-cadence-${role}-${pitch}`,
            tick: offset + (sec.bars - 1) * BAR,
            duration: 960,
            pitch,
            velocity: 0.55,
            role,
            instrument: t.instrument,
            gain: t.volume * 0.65,
            pan: role === "pad" ? t.pan : 0,
            filter: 0.5,
          });
      }
    }
    for (const clip of p.clips ?? []) {
      if (clip.sections && !clip.sections.includes(sec.kind)) continue;
      const asset = p.assets.find((a) => a.id === clip.assetId);
      if (!asset) continue;
      // A soloed MIDI role excludes audio clips, just as it excludes other tracks.
      if (!includeMuted && hasSolo) continue;
      const repeat = clip.repeatTicks ?? LOOP_TICKS;
      for (let local = clip.tick; local < sec.bars * BAR; local += repeat) {
        const duration = Math.min(clip.duration, sec.bars * BAR - local);
        events.push({
          id: `${sec.id}-${clip.id}-${local}`,
          role: clip.role,
          busId: `${clip.role}:${clip.id}`,
          instrument: clip.assetId,
          tick: offset + local,
          duration,
          pitch: asset.root + clip.pitch,
          velocity: 1,
          gain: clip.gain * (["intro", "outro"].includes(sec.kind) ? 0.75 : 1),
          pan: clip.pan,
          filter: 1,
          effects: clip.effects,
          effectTick: clip.tick,
          reverse: clip.reverse,
          sourceOffset: clip.sourceOffset,
          sourceDuration: clip.sourceDuration,
        });
      }
    }
    offset += sec.bars * BAR;
  }
  if (
    p.vocalEvents === undefined &&
    p.tagEnabled &&
    p.tagAsset &&
    p.assets.some((a) => a.id === p.tagAsset)
  )
    events.push({
      id: "user-tag",
      tick: 0,
      duration: BAR * 2,
      pitch: 60,
      velocity: 0.7,
      role: "tag",
      instrument: p.tagAsset,
      gain: 0.6,
      pan: 0,
      filter: 1,
    });
  const invalidVocals = new Set(vocalEventIssues(p).map((i) => i.eventId));
  for (const v of p.vocalEvents ?? []) {
    if (
      invalidVocals.has(v.id) ||
      !v.enabled ||
      (v.role === "tag" ? !p.tagEnabled : p.voxEnabled === false) ||
      (!includeMuted && hasSolo)
    )
      continue;
    const asset = p.assets.find((a) => a.id === v.assetId)!;
    let start = v.placement.tick;
    if (v.placement.kind === "section") {
      if (!p.arrangement) continue;
      const sectionId = v.placement.sectionId;
      const index = p.sections.findIndex((s) => s.id === sectionId);
      start += p.sections.slice(0, index).reduce((n, s) => n + s.bars * BAR, 0);
    }
    const playbackRate = 2 ** ((v.pitch + asset.tuning / 100) / 12);
    const sourceTicks =
      ((v.sourceDuration / playbackRate) * p.settings.bpm * PPQ) / 60;
    const duration =
      v.mode === "one-shot" ? sourceTicks : Math.min(v.duration, sourceTicks);
    for (let repeat = 0; repeat <= (v.repeats?.count ?? 0); repeat++) {
      const tick = start + repeat * (v.repeats?.intervalTicks ?? 0);
      if (tick >= totalTicks(p)) continue;
      events.push({
        id: `vocal:${v.id}:${repeat}`,
        busId: `vocal:${v.id}`,
        role: v.role,
        instrument: v.assetId,
        tick,
        duration,
        pitch: asset.root + v.pitch,
        velocity: 1,
        gain: v.gain,
        pan: v.pan,
        filter: 1,
        sourceOffset: v.sourceOffset,
        sourceDuration: v.sourceDuration,
        playbackRate,
        reverse: v.reverse,
        effects: v.effects,
        effectTick: 0,
        envelopeOffsetSeconds: 0,
        vocal: {
          eventId: v.id,
          mode: v.mode,
          fadeIn: v.fadeIn,
          fadeOut: v.fadeOut,
          filter: v.filter,
          overlap: v.overlap,
          chokeGroup: v.chokeGroup,
        },
      });
    }
  }
  // Explicit hat choke, including imported one-shots. Bass gates are monophonic per voice.
  const groups = new Map<string, ScoreEvent[]>();
  for (const e of events) {
    const asset = p.assets.find((a) => a.id === e.instrument),
      group =
        (e.vocal
          ? e.vocal.overlap === "choke-group"
            ? `vocal:${e.vocal.chokeGroup}`
            : ""
          : asset?.choke) ||
        (e.role === "bass"
          ? "bass"
          : ["hat", "open"].includes(e.role)
            ? "hats"
            : "");
    if (group) {
      const members = groups.get(group) ?? [];
      members.push(e);
      groups.set(group, members);
    }
  }
  for (const [group, members] of groups) {
    members.sort((a, b) => a.tick - b.tick);
    members.forEach((e, i) => {
      // Explicit vocal groups resolve simultaneous triggers in stable project order: last wins.
      const next = members
        .slice(i + 1)
        .find((n) => (e.vocal ? n.tick >= e.tick : n.tick > e.tick));
      if (next) {
        e.chokeAfter = next.tick - e.tick;
        if (e.vocal) e.duration = Math.min(e.duration, next.tick - e.tick);
        else if (group === "bass" || e.role === "open")
          e.duration = Math.max(1, Math.min(e.duration, next.tick - e.tick));
      }
      if (e.glide && e.glide.at >= e.duration) delete e.glide;
    });
  }
  // Maximum eight concurrent upper voices per role. Steal the oldest with an explicit gate.
  for (const role of ["melody", "pad", "answer", "keys", "bridge", "pedal"]) {
    const active: ScoreEvent[] = [];
    for (const e of events
      .filter((e) => e.role === role)
      .sort((a, b) => a.tick - b.tick)) {
      for (let i = active.length - 1; i >= 0; i--)
        if (active[i].tick + active[i].duration <= e.tick) active.splice(i, 1);
      if (active.length >= 8) {
        const oldest = active.shift()!;
        oldest.duration = Math.max(1, e.tick - oldest.tick);
      }
      active.push(e);
    }
  }
  for (const e of events)
    if (e.vocal)
      e.envelopeDurationSeconds = seconds(e.duration, p.settings.bpm);
  return events
    .filter((e) => !e.vocal || e.duration > 0)
    .sort(
      (a, b) =>
        a.tick - b.tick || Number(isDrum(a.role)) - Number(isDrum(b.role)),
    );
}
