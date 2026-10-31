// Reading rules for the phone app (phone app plan, P2). No imports, so the app and the Node tests load the same file.
// percentThrough and minutesLeft follow src/engine/reading.ts word for word; the test compares them with the Mac's on real snapshots.

export const WORDS_PER_MINUTE = 200;
export const DATA_CACHE = "shelf-phone-data-v1";
export const SHELL_CACHE = "shelf-phone-shell-v2";

const listOf = (value) => (Array.isArray(value) ? value : []);
const minutesFor = (words) => Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));

// Same count as wordCount in src/ingest/normalize.ts: runs of non-space characters.
export function wordCount(text) {
  if (typeof text !== "string") return 0;
  const words = text.match(/\S+/g);
  return words ? words.length : 0;
}

const sumWords = (values) => listOf(values).reduce((total, value) => total + wordCount(value), 0);

// The book's parts in reading order, as the phone file holds them: the overview, each idea (explanation, takeaways, quote), then the book takeaways.
function piecesOf(book) {
  return {
    overviewWords: wordCount(book.overview),
    ideaWords: listOf(book.ideas).map((idea) => wordCount(idea.explanation) + sumWords(idea.takeaways) + wordCount(idea.quote)),
    bookTakeawayWords: sumWords(book.takeaways),
  };
}

// The reader is at idea ideaIndex (zero-based). Words before it count as read; the idea on screen does not. An index past the last idea is the end.
function progressAt(book, ideaIndex) {
  const pieces = piecesOf(book);
  const all = pieces.overviewWords + pieces.ideaWords.reduce((sum, words) => sum + words, 0) + pieces.bookTakeawayWords;
  const index = Number.isFinite(ideaIndex) ? Math.floor(ideaIndex) : -1;
  const finished = index >= pieces.ideaWords.length;
  const ideasBefore = pieces.ideaWords.slice(0, Math.max(0, index)).reduce((sum, words) => sum + words, 0);
  const through = finished ? all : pieces.overviewWords + ideasBefore;
  return { all, through, finished };
}

export function percentThrough(book, ideaIndex) {
  const { all, through, finished } = progressAt(book, ideaIndex);
  if (finished) return 100;
  return all === 0 ? 0 : Math.round((100 * through) / all);
}

export function minutesLeft(book, ideaIndex) {
  const { all, through, finished } = progressAt(book, ideaIndex);
  const remaining = finished ? 0 : all - through;
  return remaining > 0 ? minutesFor(remaining) : 0;
}

// --- Reading position: one record per book and revision, kept on this phone. ---

const isWholeNumber = (value) => Number.isSafeInteger(value) && value >= 1;

export function positionKey(bookId, revision) {
  return `shelf-phone:position:${bookId}:${revision}`;
}

// The reader opened idea `idea`. The last idea moves freely; the furthest idea and the finish time never go back.
export function positionAfterOpen(previous, revision, idea, nowIso) {
  if (!isWholeNumber(idea)) return previous ?? null;
  const base = previous && previous.revision === revision ? previous : null;
  return {
    revision,
    lastIdea: idea,
    furthestIdea: Math.max(base ? base.furthestIdea : 0, idea),
    finishedAt: base ? base.finishedAt : null,
    updatedAt: nowIso,
  };
}

// The reader reached the end. Every idea counts as read, and the first finish time is kept.
export function positionAfterFinish(previous, revision, ideaCount, nowIso) {
  if (!Number.isSafeInteger(ideaCount) || ideaCount < 0) return previous ?? null;
  const base = previous && previous.revision === revision ? previous : null;
  return {
    revision,
    lastIdea: base ? base.lastIdea : ideaCount,
    furthestIdea: Math.max(base ? base.furthestIdea : 0, ideaCount),
    finishedAt: base && base.finishedAt ? base.finishedAt : nowIso,
    updatedAt: nowIso,
  };
}

// A stored record, or null when it is missing or damaged. A damaged record is ignored rather than trusted.
export function parsePosition(text, revision) {
  if (typeof text !== "string") return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  if (value.revision !== revision || !isWholeNumber(value.lastIdea) || !isWholeNumber(value.furthestIdea)) return null;
  if (value.finishedAt !== null && typeof value.finishedAt !== "string") return null;
  if (typeof value.updatedAt !== "string") return null;
  return { revision, lastIdea: value.lastIdea, furthestIdea: value.furthestIdea, finishedAt: value.finishedAt, updatedAt: value.updatedAt };
}

// The library's Continue card: started, not finished, and an idea to go back to.
export function isContinuing(position) {
  return position !== null && position.finishedAt === null && isWholeNumber(position.lastIdea);
}

// The one button on the book page: Read, Continue · Idea N, or Read again after the end.
export function readAction(position) {
  if (!position) return { text: "Read", idea: 1 };
  if (position.finishedAt) return { text: "Read again", idea: 1 };
  return { text: `Continue · Idea ${position.lastIdea}`, idea: position.lastIdea };
}

// --- Routes. The app is a single page; the hash says where the reader is. ---

const BOOK_ID = /^[0-9a-f]{32}$/;
const IDEA_NUMBER = /^[1-9]\d*$/;

// Anything the app does not recognise is the library, so a stale or mistyped link never shows a blank page.
export function parseRoute(hash) {
  const parts = String(hash ?? "").replace(/^#/, "").split("/").filter((part) => part !== "");
  if (parts[0] !== "books" || !BOOK_ID.test(parts[1] ?? "")) return { name: "library" };
  const bookId = parts[1];
  if (parts.length === 2) return { name: "book", bookId };
  if (parts.length === 4 && parts[2] === "read") {
    if (parts[3] === "end") return { name: "end", bookId };
    if (IDEA_NUMBER.test(parts[3])) return { name: "idea", bookId, idea: Number(parts[3]) };
  }
  return { name: "library" };
}

export const libraryHref = () => "#/";
export const bookHref = (bookId) => `#/books/${bookId}`;
export const ideaHref = (bookId, idea) => `#/books/${bookId}/read/${idea}`;
export const endHref = (bookId) => `#/books/${bookId}/read/end`;

// The same stable tone as src/web/views/cover.ts. The phone only has the display title, so a title with a bracketed part can land on another tone than the Mac's.
export function toneOf(title) {
  let hash = 0;
  for (const char of String(title)) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 6;
}
