// The phone app (phone app plan, P2). Decrypts the site in the browser and draws every screen with DOM calls.
// Text from the summaries is set with textContent, and the element tree is built with createElement, never from HTML strings.
import { decryptBytes, decryptJson, deriveKeys } from "./crypto.mjs";
import {
  DATA_CACHE,
  bookHref,
  endHref,
  ideaHref,
  isContinuing,
  libraryHref,
  minutesLeft,
  parsePosition,
  parseRoute,
  percentThrough,
  positionAfterFinish,
  positionAfterOpen,
  positionKey,
  readAction,
  toneOf,
} from "./reading.mjs";

// The same check value as src/phone/export.ts. A passphrase that opens check.enc is the right one.
const CHECK_VALUE = "shelf phone site";
const KEY_DB = "shelf-phone";
const KEY_STORE = "keys";
const TEXT_KEY = "shelf-phone:text-size";
const TEXT_SIZES = ["text-s", "text-m", "text-l"];

const main = document.getElementById("view");
const state = {
  keys: null, // { aes, names, salt, iterations } once unlocked
  library: null, // the decrypted library.enc
  books: new Map(), // "id:revision" -> decrypted book file
  covers: new Map(), // "id:revision" -> object URL
  liveCovers: new Set(), // the covers the current screen shows; others are released
  token: 0, // a newer render makes older, slower renders stop
};

// --- DOM helpers. Children may be nodes, strings, arrays, or null (skipped). ---

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function paragraphs(text) {
  return String(text ?? "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => h("p", { text: part }));
}

// A screen is one node or a list of them (the reader is a bar, a page and a pill).
function show(title, ...nodes) {
  document.title = `${title} · Shelf`;
  main.replaceChildren(...nodes.flat());
}

// --- Bytes from the site. Every fetch goes through the service worker, which serves the copy it holds when offline. ---

async function fetchBytes(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function toBase64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function imageType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "image/jpeg";
}

// --- Keys kept in IndexedDB. The CryptoKey objects are non-extractable, so the passphrase is never stored. ---

function openKeyDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function keyStore(mode, action) {
  const database = await openKeyDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE, mode);
      const request = action(transaction.objectStore(KEY_STORE));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

// Any failure here (no IndexedDB, private mode, a cleared store) means "not saved": the app asks for the passphrase again.
async function savedKeys() {
  try {
    const record = await keyStore("readonly", (store) => store.get("current"));
    if (!record || !(record.aes instanceof CryptoKey) || !(record.names instanceof CryptoKey)) return null;
    return record;
  } catch {
    return null;
  }
}

async function saveKeys(keys) {
  try {
    await keyStore("readwrite", (store) => store.put(keys, "current"));
    return true;
  } catch {
    return false;
  }
}

async function clearKeys() {
  try {
    await keyStore("readwrite", (store) => store.delete("current"));
  } catch {
    // Nothing to clear when the store is unavailable.
  }
}

// --- Unlock. ---

class UnlockError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function unlock(passphrase, onProgress) {
  let keyFile;
  let checkBytes;
  try {
    keyFile = JSON.parse(new TextDecoder().decode(await fetchBytes("key.json")));
    checkBytes = await fetchBytes("check.enc");
  } catch {
    throw new UnlockError("connect");
  }
  onProgress("Deriving keys. On a phone this takes a few seconds.");
  const salt = fromBase64(keyFile.salt);
  const keys = await deriveKeys(passphrase, salt, keyFile.iterations);
  onProgress("Checking the passphrase.");
  try {
    const check = await decryptJson(keys.aes, "check.enc", checkBytes);
    if (check.check !== CHECK_VALUE) throw new Error("the check value is wrong");
  } catch {
    throw new UnlockError("wrong");
  }
  return { aes: keys.aes, names: keys.names, salt: toBase64(salt), iterations: keyFile.iterations };
}

// --- Library. ---

async function loadLibrary() {
  const bytes = await fetchBytes("library.enc");
  let library;
  try {
    library = await decryptJson(state.keys.aes, "library.enc", bytes);
  } catch {
    // The keys do not open this site: it was rebuilt with another passphrase. The caller unlocks again.
    throw new UnlockError("rebuilt");
  }
  if (library.version !== 1 || !Array.isArray(library.books)) throw new Error("the library file is not one this app reads");
  state.library = library;
}

function loadPosition(bookId, revision) {
  try {
    return parsePosition(window.localStorage.getItem(positionKey(bookId, revision)), revision);
  } catch {
    return null;
  }
}

function savePosition(bookId, position) {
  try {
    window.localStorage.setItem(positionKey(bookId, position.revision), JSON.stringify(position));
  } catch {
    // The reader still works for this visit; only the saved place is lost.
  }
}

async function loadBook(entry) {
  const key = `${entry.id}:${entry.revision}`;
  if (state.books.has(key)) return state.books.get(key);
  let bytes;
  try {
    bytes = await fetchBytes(`books/${entry.id}.enc?v=${entry.revision}`);
  } catch {
    throw new UnlockError("offline");
  }
  let book;
  try {
    book = await decryptJson(state.keys.aes, `books/${entry.id}.enc`, bytes);
  } catch {
    throw new Error("This summary could not be opened on this phone.");
  }
  state.books.set(key, book);
  return book;
}

// --- Covers. Real covers are decrypted to blob URLs. A cover only becomes a URL while a screen that shows it is live. ---

function generatedCover(entry) {
  return h(
    "div",
    { class: `cover cover-tone-${toneOf(entry.title)}`, "aria-hidden": "true" },
    h("span", { class: "cover-title", text: entry.title }),
    entry.author ? h("span", { class: "cover-author", text: entry.author }) : null,
  );
}

// The holder shows the generated cover at once and swaps in the real one when it has been decrypted.
function coverHolder(entry, extraClass) {
  const holder = h("div", { class: `cover-holder ${extraClass ?? ""}`.trim() }, generatedCover(entry));
  if (entry.cover) {
    const key = `${entry.id}:${entry.revision}`;
    state.liveCovers.add(key);
    loadCover(entry).then((url) => {
      if (url) holder.replaceChildren(h("img", { class: "cover-img", alt: "", src: url }));
    });
  }
  return holder;
}

async function loadCover(entry) {
  const key = `${entry.id}:${entry.revision}`;
  if (state.covers.has(key)) return state.covers.get(key);
  try {
    const path = `covers/${entry.cover}.enc`;
    const bytes = await decryptBytes(state.keys.aes, path, await fetchBytes(`${path}?v=${entry.revision}`));
    if (!state.liveCovers.has(key)) return null;
    const url = URL.createObjectURL(new Blob([bytes], { type: imageType(bytes) }));
    state.covers.set(key, url);
    return url;
  } catch {
    return null;
  }
}

// Releases the covers that no live screen shows, so the decrypted images do not pile up.
function releaseCovers() {
  for (const [key, url] of state.covers) {
    if (state.liveCovers.has(key)) continue;
    URL.revokeObjectURL(url);
    state.covers.delete(key);
  }
}

function forgetCovers() {
  for (const url of state.covers.values()) URL.revokeObjectURL(url);
  state.covers.clear();
  state.liveCovers.clear();
}

// --- Screens. ---

function unlockScreen(message) {
  const status = h("p", { class: "status", role: "status", "aria-live": "polite", text: message ?? "" });
  const input = h("input", { id: "passphrase", type: "password", autocomplete: "off", autocapitalize: "none", spellcheck: "false", required: true });
  const button = h("button", { class: "button button-big", type: "submit", text: "Unlock" });
  const progress = h("progress", { class: "progress", hidden: true, "aria-label": "Unlocking" });
  const form = h(
    "form",
    {
      class: "unlock",
      onsubmit: async (event) => {
        event.preventDefault();
        const passphrase = input.value;
        input.value = "";
        input.disabled = true;
        button.disabled = true;
        progress.hidden = false;
        status.textContent = "Unlocking.";
        try {
          state.keys = await unlock(passphrase, (text) => {
            status.textContent = text;
          });
          await saveKeys(state.keys);
          render();
        } catch (error) {
          state.keys = null;
          progress.hidden = true;
          input.disabled = false;
          button.disabled = false;
          status.textContent = unlockMessage(error);
          input.focus();
        }
      },
    },
    h("label", { class: "label", for: "passphrase", text: "Passphrase" }),
    input,
    progress,
    button,
    status,
  );
  return h(
    "section",
    { class: "unlock-screen" },
    h("h1", { text: "Unlock Shelf" }),
    h("p", { class: "meta", text: "Enter the passphrase from your Mac. The phone asks once, then remembers it on this device." }),
    form,
  );
}

function unlockMessage(error) {
  if (error instanceof UnlockError) {
    if (error.reason === "wrong") return "That passphrase doesn't open this library. Check it and try again.";
    if (error.reason === "rebuilt") return "This phone's key no longer opens the library. Unlock again with the current passphrase.";
    if (error.reason === "offline") return "Connect to open this summary.";
    return "Connect to the internet to unlock this phone for the first time.";
  }
  return "Something went wrong while unlocking. Try again.";
}

function libraryScreen(notice) {
  const books = state.library.books;
  const continues = books
    .map((entry) => ({ entry, position: loadPosition(entry.id, entry.revision) }))
    .filter((item) => isContinuing(item.position))
    .sort((a, b) => (a.position.updatedAt < b.position.updatedAt ? 1 : -1));
  const continueSection = continues.length
    ? h(
        "section",
        { class: "continue", "aria-labelledby": "continue-heading" },
        h("h2", { id: "continue-heading", text: "Continue reading" }),
        h(
          "ul",
          { class: "continue-list" },
          continues.map(({ entry, position }) =>
            h(
              "li",
              null,
              h(
                "a",
                { class: "continue-card", href: ideaHref(entry.id, position.lastIdea) },
                h("span", { class: "continue-cover" }, coverHolder(entry, "cover-thumb")),
                h(
                  "span",
                  { class: "continue-text" },
                  h("span", { class: "continue-title", text: entry.title }),
                  h("span", { class: "meta", text: `Idea ${position.lastIdea} of ${entry.stats.ideas}` }),
                ),
              ),
            ),
          ),
        ),
      )
    : null;
  const grid = books.length
    ? h(
        "ul",
        { class: "covers", "aria-label": "Summaries" },
        books.map((entry) =>
          h(
            "li",
            null,
            h("a", { class: "cover-link", href: bookHref(entry.id) }, coverHolder(entry), h("span", { class: "cover-caption", text: entry.title })),
          ),
        ),
      )
    : h("p", { class: "empty", text: "No summaries on this phone yet. Publish one on the Mac, then sync." });
  return h(
    "section",
    { class: "library" },
    h("h1", { text: "Library" }),
    h("p", { class: "meta", text: books.length === 1 ? "1 summary" : `${books.length} summaries` }),
    notice ? h("p", { class: "notice", role: "status", text: notice }) : null,
    continueSection,
    h("h2", { class: "sr", text: "All summaries" }),
    grid,
    h(
      "footer",
      { class: "lock" },
      h("button", { class: "button button-quiet", type: "button", onclick: lock, text: "Lock this phone" }),
      h("p", { class: "hint", text: "Removes the key and the saved copies of your summaries from this phone. Reading positions stay." }),
    ),
  );
}

function bookScreen(entry, book) {
  const position = loadPosition(entry.id, entry.revision);
  const action = readAction(position);
  const furthest = position ? position.furthestIdea : 0;
  const ideas = book.ideas.map((idea, index) => {
    const read = index + 1 <= furthest;
    return h(
      "li",
      null,
      h(
        "a",
        { class: `idea-row${read ? " is-read" : ""}`, href: ideaHref(entry.id, index + 1) },
        h("span", { class: "idea-number", text: String(index + 1) }),
        h("span", { class: "idea-name", text: idea.title || "Untitled idea" }),
        idea.needsReview ? h("span", { class: "badge", text: "Needs review" }) : null,
        read ? h("span", { class: "read-mark", text: "Read" }) : null,
        h("span", { class: "chevron", "aria-hidden": "true", text: "›" }),
      ),
    );
  });
  return h(
    "section",
    { class: "book-page" },
    h("p", { class: "back" }, h("a", { href: libraryHref(), text: "All summaries" })),
    h(
      "div",
      { class: "book-head" },
      h("div", { class: "cover-wrap" }, coverHolder(entry)),
      h(
        "div",
        { class: "book-text" },
        h("p", { class: "eyebrow", text: "Summary" }),
        h("h1", { text: book.title }),
        book.author ? h("p", { class: "meta", text: book.author }) : null,
        h("p", { class: "stats", text: `${book.stats.ideas} key ideas · ${book.stats.minutes} min · ${book.stats.takeaways} takeaways` }),
        h("div", { class: "book-actions" }, h("a", { class: "button button-big", href: ideaHref(entry.id, action.idea), text: action.text })),
      ),
    ),
    h("section", { class: "inside" }, h("h2", { text: "What's inside" }), paragraphs(book.overview), h("ol", { class: "idea-list" }, ideas)),
  );
}

// The top bar: close to the book, the title with the step, and the text-size button.
function readerBar(entry, book, step) {
  return h(
    "header",
    { class: "reader-bar" },
    h("a", { class: "bar-close", href: bookHref(entry.id), text: "Close" }),
    h("div", { class: "bar-title" }, h("span", { class: "bar-book", text: book.title }), h("span", { class: "bar-step", text: step })),
    h("button", { class: "bar-aa", type: "button", "aria-label": "Change text size", onclick: cycleTextSize, text: "Aa" }),
  );
}

// The floating pill: Previous, the share read with minutes left, and Next. The fill's width is set through the CSSOM.
function readerPill(previous, next, percent, minutes) {
  const fill = h("span", { class: "pill-fill", "aria-hidden": "true" });
  fill.style.transform = `scaleX(${Math.min(1, Math.max(0, percent / 100))})`;
  return h(
    "nav",
    { class: "pill-nav", "aria-label": "Move between ideas" },
    h("a", { class: "pill-step", href: previous, "data-key": "prev", rel: "prev", text: "Previous" }),
    h(
      "div",
      { class: "pill-meter", role: "img", "aria-label": `${percent} percent read, ${minutes} minutes left` },
      fill,
      h("span", { class: "pill-text", "aria-hidden": "true", text: `${percent}% · ${minutes} min left` }),
    ),
    next
      ? h("a", { class: "pill-step pill-next", href: next, "data-key": "next", rel: "next", text: "Next" })
      : h("span", { class: "pill-step pill-spacer", "aria-hidden": "true" }),
  );
}

function ideaScreen(entry, book, index) {
  const total = book.ideas.length;
  const idea = book.ideas[index - 1];
  savePosition(entry.id, positionAfterOpen(loadPosition(entry.id, entry.revision), entry.revision, index, new Date().toISOString()));
  const previous = index > 1 ? ideaHref(entry.id, index - 1) : bookHref(entry.id);
  const next = index < total ? ideaHref(entry.id, index + 1) : endHref(entry.id);
  return [
    readerBar(entry, book, `Idea ${index} of ${total}`),
    h(
      "article",
      { class: "reader idea-page" },
      h("h1", { class: "idea-title", text: idea.title || "Untitled idea" }),
      idea.needsReview ? h("p", { class: "badge", text: "Needs review" }) : null,
      h("div", { class: "idea-body" }, paragraphs(idea.explanation)),
      idea.takeaways.length
        ? h("section", { class: "idea-takeaways" }, h("h2", { text: "Takeaways" }), h("ul", { class: "takeaways" }, idea.takeaways.map((item) => h("li", { text: item }))))
        : null,
      idea.quote
        ? h("blockquote", null, h("p", { text: idea.quote }), idea.chapter ? h("footer", { text: idea.chapter }) : null)
        : h("p", { class: "hint", text: "No quote was verified for this idea." }),
    ),
    readerPill(previous, next, percentThrough(book, index - 1), minutesLeft(book, index - 1)),
  ];
}

function endScreen(entry, book) {
  const total = book.ideas.length;
  savePosition(entry.id, positionAfterFinish(loadPosition(entry.id, entry.revision), entry.revision, total, new Date().toISOString()));
  const previous = total > 0 ? ideaHref(entry.id, total) : bookHref(entry.id);
  return [
    readerBar(entry, book, "Finished"),
    h(
      "article",
      { class: "reader idea-page end-page" },
      h("h1", { class: "idea-title", text: "You've finished" }),
      h("p", { class: "meta", text: book.title }),
      book.takeaways.length
        ? h("section", { class: "book-takeaways" }, h("h2", { text: "Takeaways" }), h("ul", { class: "takeaways" }, book.takeaways.map((item) => h("li", { text: item }))))
        : null,
      h(
        "p",
        { class: "end-actions" },
        h("a", { class: "button", href: bookHref(entry.id), text: "Back to the book" }),
        " ",
        h("a", { class: "button button-quiet", href: libraryHref(), text: "Library" }),
      ),
    ),
    readerPill(previous, null, 100, 0),
  ];
}

function messageScreen(title, text, href) {
  return h("section", { class: "message" }, h("h1", { text: title }), h("p", { class: "meta", text }), h("p", null, h("a", { class: "button button-quiet", href, text: "Back to the library" })));
}

// --- Text size: three steps, kept on this phone. ---

function applyTextSize(name) {
  for (const size of TEXT_SIZES) document.documentElement.classList.remove(size);
  document.documentElement.classList.add(name);
}

function cycleTextSize() {
  let current = "text-m";
  try {
    const stored = window.localStorage.getItem(TEXT_KEY);
    if (TEXT_SIZES.includes(stored)) current = stored;
  } catch {
    // The default size is used when storage is unavailable.
  }
  const next = TEXT_SIZES[(TEXT_SIZES.indexOf(current) + 1) % TEXT_SIZES.length];
  applyTextSize(next);
  try {
    window.localStorage.setItem(TEXT_KEY, next);
  } catch {
    // The size still applies for this visit.
  }
}

function restoreTextSize() {
  let stored = null;
  try {
    stored = window.localStorage.getItem(TEXT_KEY);
  } catch {
    stored = null;
  }
  applyTextSize(TEXT_SIZES.includes(stored) ? stored : "text-m");
}

// --- Lock: the key goes, and so does every saved copy of the summaries. ---

async function lock() {
  await clearKeys();
  try {
    await caches.delete(DATA_CACHE);
  } catch {
    // Nothing cached to remove.
  }
  forgetCovers();
  state.keys = null;
  state.library = null;
  state.books.clear();
  state.token += 1;
  render();
}

// --- Routing. ---

// Keys for the arrow keys: the pill's Previous and Next, as on the Mac reader.
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const which = event.key === "ArrowLeft" ? "prev" : event.key === "ArrowRight" ? "next" : null;
  if (!which) return;
  const link = document.querySelector(`[data-key="${which}"]`);
  if (link) window.location.assign(link.getAttribute("href"));
});

async function render() {
  const token = (state.token += 1);
  state.liveCovers = new Set();
  if (!state.keys) {
    show("Unlock", unlockScreen(state.notice));
    state.notice = null;
    return;
  }
  if (!state.library) {
    show("Shelf", h("p", { class: "meta", role: "status", text: "Opening your library." }));
    try {
      await loadLibrary();
    } catch (error) {
      if (token !== state.token) return;
      if (error instanceof UnlockError && error.reason === "rebuilt") {
        await clearKeys();
        state.keys = null;
        state.notice = unlockMessage(error);
        return render();
      }
      show("Shelf", h("section", { class: "message" }, h("h1", { text: "The library did not open" }), h("p", { class: "meta", text: "Connect once to refresh it. Your saved copies open again when you reconnect." })));
      return;
    }
  }
  const route = parseRoute(location.hash);
  if (route.name === "library") {
    show("Library", libraryScreen(state.notice));
    state.notice = null;
    releaseCovers();
    return;
  }
  const entry = state.library.books.find((item) => item.id === route.bookId);
  if (!entry) {
    show("Not here", messageScreen("Not on this phone", "This summary is not in the library on this phone.", libraryHref()));
    return;
  }
  show(entry.title, h("p", { class: "meta", role: "status", text: "Opening the summary." }));
  let book;
  try {
    book = await loadBook(entry);
  } catch (error) {
    if (token !== state.token) return;
    const text = error instanceof UnlockError ? "Connect to open this summary. Once it has been opened, it works offline." : error.message;
    show(entry.title, messageScreen("Not opened yet", text, libraryHref()));
    return;
  }
  if (token !== state.token) return;
  if (route.name === "book") {
    show(entry.title, bookScreen(entry, book));
    releaseCovers();
    return;
  }
  if (route.name === "end") {
    show(entry.title, endScreen(entry, book));
    releaseCovers();
    return;
  }
  if (route.name === "idea") {
    if (route.idea > book.ideas.length) {
      show(entry.title, messageScreen("No such idea", `This summary has ${book.ideas.length} key ideas.`, bookHref(entry.id)));
      return;
    }
    show(entry.title, ideaScreen(entry, book, route.idea));
    releaseCovers();
  }
}

// The reader's full-width layout is set on the page only while a reader screen is open.
window.addEventListener("hashchange", () => {
  document.body.classList.toggle("is-reader", parseRoute(location.hash).name === "idea" || parseRoute(location.hash).name === "end");
  render();
});

// --- Start. ---

async function start() {
  restoreTextSize();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  state.keys = await savedKeys();
  document.body.classList.toggle("is-reader", parseRoute(location.hash).name === "idea" || parseRoute(location.hash).name === "end");
  render();
}

start();
