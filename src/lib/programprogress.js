'use strict';

// A program's progress in words (release 2026.11.20): one function for the Today card and the program page, so both say
// the same thing ("11 of 24 done, 1 skipped, 2 failed, 10 to do"). "Done" counts the targets inspected; skipped ones are
// said apart, as the program page always has. Failed ones are among the done.

/** progress: { total, done, skipped, failed, todo } (routes/assetprograms.js programOut). */
function progressWords(pr) {
  const p = { total: Number(pr.total) || 0, done: Number(pr.done) || 0, skipped: Number(pr.skipped) || 0, failed: Number(pr.failed) || 0 };
  const todo = pr.todo === undefined ? p.total - p.done - p.skipped : Number(pr.todo);
  return `${p.done} of ${p.total} done${p.skipped ? `, ${p.skipped} skipped` : ''}${p.failed ? `, ${p.failed} failed` : ''}${todo ? `, ${todo} to do` : ''}`;
}

module.exports = { progressWords };
