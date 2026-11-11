import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

// Building blocks for the skill passport (roadmap E4), following W3C specifications:
// - JSON Canonicalization Scheme (RFC 8785) for hashing documents;
// - Data Integrity "eddsa-jcs-2022" proofs (W3C Data Integrity EdDSA Cryptosuites v1.0) with Ed25519;
// - Multikey public keys and base58btc multibase values;
// - Bitstring Status List v1.0 for revocation.

// RFC 8785: object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and string forms.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Cannot canonicalize a non-finite number.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
  }
  throw new Error('Cannot canonicalize this value.');
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58btc(bytes: Uint8Array) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
export function fromBase58btc(text: string) {
  let n = 0n;
  for (const c of text) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error('Invalid base58 text.'); n = n * 58n + BigInt(i); }
  const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of text) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

// Ed25519 keys. The private key comes from PASSPORT_SIGNING_KEY (PKCS#8 PEM); in production it belongs in
// Secret Manager or, as the roadmap plans, Cloud KMS behind the same sign() call.
const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01]);
export function generateSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
export function loadSigningKey(pem: string) {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The passport signing key must be Ed25519.');
  return { privateKey, publicKey: createPublicKey(privateKey) };
}
export function publicKeyMultibase(publicKey: KeyObject) {
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return `z${base58btc(Uint8Array.from([...ED25519_MULTICODEC, ...raw]))}`;
}
export function publicKeyFromMultibase(multibase: string) {
  if (!multibase.startsWith('z')) throw new Error('Expected a base58btc multibase key.');
  const bytes = fromBase58btc(multibase.slice(1));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error('Not an Ed25519 Multikey.');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(bytes.slice(2)).toString('base64url') }, format: 'jwk' });
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
type Doc = Record<string, unknown> & { '@context'?: unknown; proof?: unknown };
export type Proof = { type: 'DataIntegrityProof'; cryptosuite: 'eddsa-jcs-2022'; created: string; verificationMethod: string; proofPurpose: 'assertionMethod'; proofValue?: string };

// eddsa-jcs-2022: hash the canonical proof options (with the document's @context) and the canonical document
// without its proof, concatenate (options first), and sign with Ed25519.
function hashData(doc: Doc, options: Omit<Proof, 'proofValue'>) {
  const { proof: _ignored, ...unsecured } = doc;
  return Buffer.concat([sha256(canonicalize({ ...options, '@context': doc['@context'] })), sha256(canonicalize(unsecured))]);
}
export function addProof<T extends Doc>(doc: T, privateKey: KeyObject, verificationMethod: string, created = new Date()): T & { proof: Proof } {
  const options = { type: 'DataIntegrityProof' as const, cryptosuite: 'eddsa-jcs-2022' as const, created: created.toISOString().replace(/\.\d{3}Z$/, 'Z'), verificationMethod, proofPurpose: 'assertionMethod' as const };
  const signature = sign(null, hashData(doc, options), privateKey);
  return { ...doc, proof: { ...options, proofValue: `z${base58btc(signature)}` } };
}
export function verifyProof(doc: Doc, resolveKey: (verificationMethod: string) => KeyObject | null) {
  const proof = doc.proof as Proof | undefined;
  if (!proof || proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022' || proof.proofPurpose !== 'assertionMethod' || !proof.proofValue?.startsWith('z')) return false;
  const key = resolveKey(proof.verificationMethod);
  if (!key) return false;
  const { proofValue, ...options } = proof;
  try { return verify(null, hashData(doc, options), key, Buffer.from(fromBase58btc(proofValue.slice(1)))); } catch { return false; }
}

// Bitstring Status List: at least 131,072 entries (16 KB) so a list does not reveal which credential is checked.
export const STATUS_LIST_BITS = 131_072;
export function encodeStatusList(revoked: Iterable<number>, bits = STATUS_LIST_BITS) {
  const bytes = new Uint8Array(bits / 8);
  for (const i of revoked) { if (i < 0 || i >= bits) throw new Error('Status index out of range.'); bytes[i >> 3] |= 0x80 >> (i & 7); } // left-most bit is index 0
  return `u${gzipSync(bytes).toString('base64url')}`;
}
export function statusBit(encodedList: string, index: number) {
  if (!encodedList.startsWith('u')) throw new Error('Expected a base64url multibase status list.');
  const bytes = gunzipSync(Buffer.from(encodedList.slice(1), 'base64url'));
  if (index < 0 || index >= bytes.length * 8) throw new Error('Status index out of range.');
  return (bytes[index >> 3] & (0x80 >> (index & 7))) !== 0;
}
