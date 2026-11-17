# Playback additions

Disc title selection follows the existing Jellyfin legacy playback UI. It is not a
new visual system. Layout, colors, fonts, focus and scrolling remain owned by the
existing theme styles and components.

- Non-fullscreen cancellation stays below the choices in the existing action sheet
  stylesheet; the fullscreen back button keeps its fixed placement.
- Selection owner: `src/components/actionSheet/actionSheet.ts`, also used by player settings.
- Playback settings owner: `src/components/playback/playersettingsmenu.js`.
- Loading and errors: existing `loading` and playback error handling.
- Copy: `src/strings/en-us.json` with the existing locale fallback and translation workflow.
- Disc ambiguity opens a cancellable action sheet. Choosing a title starts that
  title with its own saved position; cancellation never plays a guessed title.
- A player settings entry allows changing a remembered title. No new CSS tokens,
  inline colors, custom dialog implementation or unrelated screen changes.

Verify this workflow with the existing keyboard navigation and a narrow viewport.

Disc buffering reuses the video OSD's text/flat-button styles and the existing
loading indicator. The inline status announces buffered seconds and offers Play
without adding a settings panel. Automatic waits are distinct from manual pauses.
The dashboard uses its existing Checkbox/FormControl pattern for the server's
opt-in disc adaptive-quality setting. Source labels and video/audio/subtitle
selectors remain owned by the existing item-details workflow.
