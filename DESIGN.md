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
