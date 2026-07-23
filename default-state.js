// default-state.js
// -----------------------------------------------------------------------
// Values used only to seed a brand-new, empty database. Deliberately
// minimal/empty rather than trying to duplicate the frontend's own
// built-in defaults (SCHOOL, SESSION, QT_CONFIG, etc.) — the frontend
// already knows those, and will push its real state to the server on
// the very first autosave anyway. This just prevents 404s on first load.
// -----------------------------------------------------------------------
const DEFAULT_STATE = {
  institution: { name: '', address: '', session: '', watermark: '' },
  paper_patterns: {},
  question_bank: {},
  saved_papers: [],
  custom_classes: [],
  custom_chapters: [],
  custom_qtypes: null,
  deleted_builtins: { classes: [], chapters: [], qtypes: [] },
};

module.exports = { DEFAULT_STATE };
