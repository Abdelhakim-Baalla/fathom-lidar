# Fathom audio sources

## Active samples

- `scan.mp3`: **Scanner 01.wav**, Glitchedtones. Source: https://freesound.org/people/Glitchedtones/sounds/375944/ . Downloaded from the creator page's high-quality MP3 preview: https://cdn.freesound.org/previews/375/375944_3294528-hq.mp3 . Duration: approximately 1.53 seconds.
- `radar.mp3`: **Radar**, avreference. Source: https://freesound.org/people/avreference/sounds/575419/ . Downloaded from the creator page's high-quality MP3 preview: https://cdn.freesound.org/previews/575/575419_9243191-hq.mp3 . Duration: approximately 4.57 seconds.

Both source pages explicitly identify the sounds as **CC0 1.0**: https://creativecommons.org/publicdomain/zero/1.0/ . Verified and downloaded 2026-11-16. Files are hosted locally; playback does not contact Freesound. These are externally authored designed sound effects, not recordings of actual military equipment.

The intro composition, low-frequency impacts, filtered mechanical transients and RWR-inspired warning cadence are original procedural audio in `src/audio/cues.ts`. Browser audio starts only after a user gesture. Warnings are finite and rate-limited; muting or skipping cancels scheduled sources. Interface audio suppresses the microphone event detector for its playback window.

## User reference soundtrack

The exact second reference is **Futuristic HUD Sound Design**, Blake Sanchez: https://www.youtube.com/watch?v=J-FkR8L2X5E . The creator sells a non-exclusive licence and the original 51-second WAV at https://blakesanchez.com/store/hud . That paid recording is **not bundled**. A user can load their own licensed file from Audio → Use your own audio. The intro plays the first 6.4 seconds; trim a preferred passage before importing. Local overrides remain in memory for this session and are not uploaded or published.

The other supplied video references are https://www.youtube.com/watch?v=S2kymv60ndQ and https://www.youtube.com/watch?v=J0NhUDUENbg . No audio has been extracted from them. No Hitman, FBI or other agency's assets are bundled.

## Interface samples

`click.ogg` and `confirm.ogg` are active; `scanner.ogg` is retained as an unused asset. Sources: Kenney Interface Sounds (`click_001.ogg`, `confirmation_001.ogg`) and Kenney Sci-fi Sounds (`computerNoise_000.ogg`). CC0 1.0. Primary pages: https://kenney.nl/assets/interface-sounds and https://kenney.nl/assets/sci-fi-sounds . Downloaded from https://github.com/Mcamento8/open-game-sfx-index/tree/main/audio on 2026-11-16.
