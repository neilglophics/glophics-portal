/**
 * Per-viewer display state that isn't shared/synced data — which table
 * rows and repo notes are expanded, and table-vs-board view mode. Kept
 * separate from the app's data State so components that only care about
 * "is this open" don't need to depend on the whole data store.
 */

const UiState = (() => {
  let viewMode = "table";
  const openRows = new Set();
  const openNotes = new Set();

  function getViewMode() { return viewMode; }
  function setViewMode(mode) { viewMode = mode; }

  function isRowOpen(serverId) { return openRows.has(serverId); }
  function toggleRowOpen(serverId) {
    if (openRows.has(serverId)) openRows.delete(serverId);
    else openRows.add(serverId);
  }

  function noteKey(serverId, repoName) { return `${serverId}::${repoName}`; }
  function isNoteOpen(serverId, repoName) { return openNotes.has(noteKey(serverId, repoName)); }
  function toggleNoteOpen(serverId, repoName) {
    const key = noteKey(serverId, repoName);
    if (openNotes.has(key)) openNotes.delete(key);
    else openNotes.add(key);
  }

  return {
    getViewMode, setViewMode,
    isRowOpen, toggleRowOpen,
    isNoteOpen, toggleNoteOpen
  };
})();
