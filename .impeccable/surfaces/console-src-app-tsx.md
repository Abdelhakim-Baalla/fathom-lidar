---
version: 1
slug: "console-src-app-tsx"
primary_target: "console/src/App.tsx"
related_targets: []
---

# Console (live scan)

Scope: the single working screen of Fathom. Mode: Operate.

Audience and job: a reviewer, engineer or student watching three sensors at once (a spinning LiDAR, Wi-Fi channel state, a microphone), reading what each detected and keeping a sealed record. Constraints: desktop first and usable on an Android phone for the room scan; 60 fps with up to 2.3 M points per second; everything simulated is labelled simulated; estimated or heuristic results say so.

Memorable moment: yellow numbered evidence markers standing on each tracked object in the live scan, with the same numbers in the exhibit register and on the evidence timeline.

Unresolved: recordings library and per-exhibit report export are not built.

## Direction contract

THESIS: The console handles sensor output the way an evidence unit handles a scene: every detection becomes a numbered exhibit with its proof beside it, every recording is sealed with its hash. It refuses the grey robotics viewer with a rainbow ramp and the neon hacker HUD.

OWN-WORLD: Gunmetal locker greys for the shell, label-stock off-white for exhibit labels and primary ink, scene-marker yellow for exhibits (markers, boxes, numbers), seal-tape red only for recording, seals and the simulated badge, forensic-light blue for Wi-Fi data. Sofia Sans for text with tabular figures, Sofia Sans Extra Condensed for headings and marker numerals, a mono only for hashes. Square corners, 2 px radius at most. One 8 px cell module (Crouwel raise).

STORY: The visitor sees the scan with markers, reads exhibits in the register, watches Wi-Fi and acoustic lanes on one evidence timeline, records, and gets a sealed exhibit with its SHA-256.

FIRST VIEWPORT: 56 px bar (wordmark, case number, three feed chips, sound toggle, simulated badge); 272 px left control rail; scan in the centre with markers; 336 px exhibit register on the right with selected-exhibit detail; 208 px bottom strip: transport, tabbed instrument (range image, Wi-Fi CSI, acoustic spectrogram) and the three-lane evidence timeline with bar length equal to real duration (Labanotation raise). Primary action: pause/resume. Acoustic lock-on inverts its lane for one frame (Ikeda raise). Each exhibit lists points, SNR or confidence beside it (Monochrome-product raise).

FORM: Chain of Custody, position 6 of 7; seed:bf86b997cdcb44f2. Signature move: numbered scene markers on tracked objects, one numbering across register, timeline and seals. Motion: 120 to 220 ms state changes, marker drop on confirmation, seal stamp on recording stop; no load choreography.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
