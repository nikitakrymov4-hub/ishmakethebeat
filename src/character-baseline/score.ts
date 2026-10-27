import { BAR, LOOP_TICKS, isDrum } from "../engine/schema";
import type { Project, ScoreEvent, Section, Role } from "../engine/schema";
export const totalTicks = (p: Project) =>
  p.arrangement ? p.sections.reduce((n, s) => n + s.bars * BAR, 0) : LOOP_TICKS;
function presence(section: Section, role: Role, localBar: number): boolean {
  if (section.kind === "intro")
    return (
      role === "melody" || role === "pad" || (localBar >= 2 && role === "hat")
    );
  if (section.kind === "outro")
    return ["melody", "pad", "answer"].includes(role);
  if (section.kind === "break")
    return (
      ["melody", "pad", "answer", "perc"].includes(role) ||
      (localBar >= section.bars - 2 && role === "clap")
    );
  if (section.kind === "verse")
    return (
      role !== "answer" &&
      !(role === "pad" && localBar % 8 >= 4) &&
      !(localBar % 8 === 7 && ["kick", "open"].includes(role))
    );
  return !(localBar % 8 === 7 && role === "bass");
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
    for (let bar = 0; bar < sec.bars; bar++)
      for (const t of c.tracks) {
        if (
          p.arrangement &&
          p.settings.profile === "culture" &&
          sec.kind === "outro" &&
          bar === sec.bars - 1
        )
          continue;
        if (!includeMuted && (t.mute || (hasSolo && !t.solo))) continue;
        if (p.arrangement && !presence(sec, t.id, bar)) continue;
        for (const n of t.notes) {
          if (Math.floor(n.tick / BAR) !== bar % 8) continue;
          const tick = offset + bar * BAR + (n.tick % BAR),
            end = offset + sec.bars * BAR;
          const filtered =
            p.arrangement && ["intro", "outro"].includes(sec.kind);
          const gain = filtered ? 0.7 : 1;
          events.push({
            ...n,
            id: `${sec.id}-${bar}-${n.id}`,
            tick,
            duration: Math.max(15, Math.min(n.duration, end - tick)),
            role: t.id,
            instrument: t.instrument,
            gain: t.volume * gain,
            pan: t.id === "bass" ? 0 : t.pan,
            filter: filtered ? 0.42 : 1,
          });
        }
      }
    if (
      p.arrangement &&
      p.settings.profile === "culture" &&
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
    offset += sec.bars * BAR;
  }
  if (p.tagEnabled && p.tagAsset && p.assets.some((a) => a.id === p.tagAsset))
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
  // Explicit hat choke, including imported one-shots. Bass gates are monophonic per voice.
  const groups = new Map<string, ScoreEvent[]>();
  for (const e of events) {
    const asset = p.assets.find((a) => a.id === e.instrument),
      group =
        asset?.choke ||
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
      const next = members.slice(i + 1).find((n) => n.tick > e.tick);
      if (next) {
        e.chokeAfter = next.tick - e.tick;
        if (group === "bass" || e.role === "open")
          e.duration = Math.max(1, Math.min(e.duration, next.tick - e.tick));
      }
      if (e.glide && e.glide.at >= e.duration) delete e.glide;
    });
  }
  // Maximum eight concurrent upper voices per role. Steal the oldest with an explicit gate.
  for (const role of ["melody", "pad", "answer"]) {
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
  return events.sort(
    (a, b) =>
      a.tick - b.tick || Number(isDrum(a.role)) - Number(isDrum(b.role)),
  );
}
