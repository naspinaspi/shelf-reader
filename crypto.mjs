// Encryption for the phone site (phone app plan, P1). The Mac builds the files with this module and the phone app imports the same file,
// so it has no imports and uses only globalThis.crypto: PBKDF2-SHA256 for keys, AES-GCM for files, HMAC-SHA256 for file names.

export const DEFAULT_ITERATIONS = 600_000;

const SALT_MIN_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = globalThis.crypto.subtle;

// One passphrase gives two keys. PBKDF2 makes 512 bits, and the first 256 become the AES-GCM key, the rest the name key.
export async function deriveKeys(passphrase, salt, iterations = DEFAULT_ITERATIONS) {
  if (typeof passphrase !== "string" || passphrase === "") throw new Error("a passphrase is needed");
  if (!(salt instanceof Uint8Array) || salt.length < SALT_MIN_BYTES) throw new Error("the salt is too short");
  const base = await subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 512));
  const aes = await subtle.importKey("raw", bits.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const names = await subtle.importKey("raw", bits.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { aes, names };
}

// The file is the IV followed by the ciphertext and its tag. The site path is authenticated, so a file cannot be renamed or swapped.
export async function encryptBytes(aes, path, plain) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(path) }, aes, plain));
  const file = new Uint8Array(IV_BYTES + sealed.length);
  file.set(iv, 0);
  file.set(sealed, IV_BYTES);
  return file;
}

// Throws when the passphrase is wrong, the bytes were changed, or the file was stored under another path.
export async function decryptBytes(aes, path, file) {
  if (!(file instanceof Uint8Array) || file.length < IV_BYTES + TAG_BYTES) throw new Error(`${path} is not an encrypted file`);
  const iv = file.slice(0, IV_BYTES);
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(path) }, aes, file.slice(IV_BYTES)));
  } catch {
    throw new Error(`${path} could not be decrypted`);
  }
}

export async function encryptJson(aes, path, value) {
  return encryptBytes(aes, path, encoder.encode(JSON.stringify(value)));
}

export async function decryptJson(aes, path, file) {
  return JSON.parse(decoder.decode(await decryptBytes(aes, path, file)));
}

// A file name that reveals nothing: the first 16 bytes of HMAC-SHA256 over a label such as "book:7", as hex.
// The same passphrase and salt give the same name every time, so a rebuilt site keeps its file names.
export async function nameFor(names, label) {
  const mac = new Uint8Array(await subtle.sign("HMAC", names, encoder.encode(label)));
  return Array.from(mac.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
