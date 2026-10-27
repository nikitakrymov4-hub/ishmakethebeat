import type { Project } from "../engine/schema";
import { validateProject } from "../io/persistence";
export default function ListeningRoom({
  onOpen,
  onStop,
}: {
  onOpen: (p: Project) => void;
  onStop: () => void;
}) {
  const items = [
    {
      name: "Accepted melody · preserved baseline",
      audio: "character/comparison/accepted-matched.wav",
      project: "character/baseline/accepted-project.ish.json",
      detail: "MIDNIGHT-041 · original28-note melody · level matched",
    },
    {
      name: "Accepted melody · coordinated ensemble",
      audio: "character/comparison/ensemble-matched.wav",
      project: "character/comparison/ensemble-project.ish.json",
      detail:
        "Same melody notes/rhythm · new ensemble, sources, phrase effects · matched",
    },
    {
      name: "Woven glass · full original-score beat",
      audio: "character/original/full.wav",
      project: "character/original/project.ish.json",
      detail: "64bars ·148BPM ·1:48 including4s tail",
    },
    {
      name: "@lilfrus LOOP10 · supplied-loop production",
      audio: "character/loop/full.wav",
      project: "character/loop/project.ish.json",
      detail:
        "Direct credited audio ·155BPM ·1:43 including4s tail · provisional bass",
    },
    ...["WOVEN-127", "VELVET-304", "COPPER-892"].map((seed, i) => ({
      name: seed,
      audio: `character/generated/${seed}.wav`,
      project: `character/generated/${seed}.ish.json`,
      detail: `${[16, 24, 32][i]}bars · independently generated conversing ensemble`,
    })),
    {
      name: "Supplied piano phrase + silent guide",
      audio: "character/generated/supplied-midi.wav",
      project: "character/generated/supplied-midi-and-silent-guide.ish.json",
      detail:
        "Imported146-note composition ·147BPM · scale guide does not sound",
    },
    {
      name: "A · Original baseline",
      audio: "comparison/A-matched.wav",
      project: "baseline/A-project.ish.json",
      detail: "Existing score, palette, and mix",
    },
    {
      name: "B · Revised palette",
      audio: "comparison/B-matched.wav",
      project: "comparison/B-project.ish.json",
      detail: "The exact same notes as A",
    },
    {
      name: "C · Paper lantern",
      audio: "comparison/C-matched.wav",
      project: "comparison/C-project.ish.json",
      detail: "New authored motif and coordinated recipe",
    },
    {
      name: "Paper lantern · full song",
      audio: "calibration/listening-master.wav",
      project: "calibration/project.ish.json",
      detail: "64 bars · 148 BPM · 1:45 with tail",
    },
    ...["PAPER-219", "GARDEN-083", "ORBIT-406"].map((seed, i) => ({
      name: seed,
      audio: `generated/${seed}.wav`,
      project: `generated/${seed}.ish.json`,
      detail: `${[16, 24, 32][i]} bars · additional generated seed`,
    })),
  ];
  return (
    <>
      <div className="eyebrow">THE LISTENING ROOM</div>
      <h2>Hear the decisions.</h2>
      <p>
        The accepted melody comparison uses reversible level matching. Open the
        review page for ensemble stages, hat treatments and sample-set
        comparisons. New renders await musical listening review.
      </p>
      <p>
        <a
          href="/deliverables/character/listen.html"
          target="_blank"
          rel="noreferrer"
        >
          Open complete sound-character listening review ↗
        </a>
      </p>
      <div className="demo-list">
        {items.map((item) => (
          <div key={item.name}>
            <div>
              <strong>{item.name}</strong>
              <span>{item.detail}</span>
              <button
                className="secondary"
                onClick={async () => {
                  const response = await fetch(`/deliverables/${item.project}`);
                  if (!response.ok) {
                    alert(
                      "Render project unavailable. See the deliverables folder in the local project.",
                    );
                    return;
                  }
                  onOpen(validateProject(await response.json()));
                }}
              >
                Open session ↗
              </button>
            </div>
            <audio
              controls
              preload="none"
              aria-label={`${item.name} rendered audio`}
              src={`/deliverables/${item.audio}`}
              onPlay={(e) => {
                onStop();
                document.querySelectorAll("audio").forEach((a) => {
                  if (a !== e.currentTarget) a.pause();
                });
              }}
            />
          </div>
        ))}
      </div>
      <p className="muted">
        Use Melody, Bass, and Drums in the workspace to audition the score by
        role. The private supplied kit is embedded in each revised project.
      </p>
    </>
  );
}
