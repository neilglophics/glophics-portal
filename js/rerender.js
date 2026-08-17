/**
 * Targeted re-render for pure UI-state changes (row/note expand-collapse,
 * view mode) that don't go through State.notify() — those already trigger
 * the app's full renderAll(). References the other components by their
 * global name only inside the function body, so it's safe to load this
 * script in any order relative to them as long as they're all present by
 * the time a UI-state toggle actually fires.
 */

const Rerender = (() => {
  function views() {
    EnvTable.render();
    EnvBoard.render();
  }
  return { views };
})();
