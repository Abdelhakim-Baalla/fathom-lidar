---
version: 1
slug: "console-src-app-tsx"
primary_target: "console/src/App.tsx"
related_targets: []
---

# Console (live scan)

Scope: the single working screen of Fathom. Mode: Operate.

Audience and job: a reviewer, engineer or student watching a spinning LiDAR measure a street, changing the sensor and reading what was detected. Constraints: desktop first, 60 fps with up to 2.3 M points per second, everything simulated is labelled as simulated.

Memorable moment: the scan sweeping over a chart-tinted ground while range contours carry their distances like soundings.

Unresolved: additional pages (recordings library, sensor datasheet view) are not built; the console holds recording and source controls inline.

## Direction contract

THESIS: LiDAR is sounding with light, so the console is set in the language of the hydrographic chart. It refuses the near-black viewer with a rainbow ramp and one neon accent.

OWN-WORLD: buff chart paper for the shell, ink navy for the bar and text, stepped depth-tint blues under the point cloud, hypsometric greens and browns for height, amber for retroreflectors. Chart magenta is reserved for everything computed: detections, tracks, selection. Archivo, upright for labels, italic for measured values, condensed for table heads. Day, Dusk and Night palettes.

STORY: the visitor sees what the sensor measures, changes a parameter and sees the physics answer, then selects a tracked object and reads its range and speed.

FIRST VIEWPORT: 48 px ink bar (name, source, simulated badge, palette switch); 288 px left rail of standard controls (sensor, environment, display); the point cloud fills the centre, nothing overlapping it but projected labels; 320 px right panel with the tracked-object table and selected-object detail; bottom strip with the range image and transport. Primary action: pause/resume in the bottom strip.

FORM: Sounding Chart, position 5 of 7; seed:f806b26dc8447f70. Signature move: range contours labelled as soundings over stepped depth tints. Motion: state changes in 150 to 250 ms, eased camera moves, palette crossfade; no load choreography.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
