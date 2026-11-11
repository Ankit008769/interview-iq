import { describe, expect, it } from 'vitest';
import { addProof, base58btc, canonicalize, encodeStatusList, fromBase58btc, generateSigningKey, loadSigningKey, publicKeyFromMultibase, publicKeyMultibase, statusBit, STATUS_LIST_BITS, verifyProof } from '../src/passport/crypto.js';

describe('passport cryptography', () => {
  it('canonicalizes JSON as RFC 8785 does', () => {
    expect(canonicalize({ b: 2, a: [true, null, 'x'], c: { z: 1, y: undefined, '€': 'é' } })).toBe('{"a":[true,null,"x"],"b":2,"c":{"z":1,"€":"é"}}');
    // Keys sort by UTF-16 code units, numbers use ECMAScript form (RFC 8785 section 3.2.2.3 and 3.2.3).
    expect(canonicalize({ '€': 1, '\r': 2, '1': 3, '😀': 4, 'ö': 5 })).toBe('{"\\r":2,"1":3,"ö":5,"€":1,"😀":4}');
    expect(canonicalize([1e21, 1e-7, -0, 0.1 + 0.2, 333333333.33333329])).toBe('[1e+21,1e-7,0,0.30000000000000004,333333333.3333333]');
    expect(() => canonicalize({ n: NaN })).toThrow();
  });
  it('encodes base58btc like the reference implementation', () => {
    expect(base58btc(Buffer.from('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58btc(Uint8Array.from([0, 0, 1]))).toBe('112');
    expect(Buffer.from(fromBase58btc('2NEpo7TZRRrLZSi2U')).toString()).toBe('Hello World!');
    expect(() => fromBase58btc('0OIl')).toThrow();
  });
  it('signs with eddsa-jcs-2022 and detects any change', () => {
    const { privateKey, publicKey } = loadSigningKey(generateSigningKey());
    const multikey = publicKeyMultibase(publicKey);
    expect(multikey).toMatch(/^z6Mk/); // every Ed25519 Multikey starts this way
    const resolve = (vm: string) => (vm === 'did:web:example.test#key-1' ? publicKeyFromMultibase(multikey) : null);
    const doc = { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential'], issuer: 'did:web:example.test', credentialSubject: { name: 'Asha', count: 12 } };
    const signed = addProof(doc, privateKey, 'did:web:example.test#key-1', new Date('2026-11-11T10:00:00.123Z'));
    expect(signed.proof).toMatchObject({ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2026-11-11T10:00:00Z', proofPurpose: 'assertionMethod' });
    expect(verifyProof(signed, resolve)).toBe(true);
    // Key order does not matter (canonical form), content does.
    const reordered = { proof: signed.proof, credentialSubject: { count: 12, name: 'Asha' }, issuer: signed.issuer, type: signed.type, '@context': signed['@context'] };
    expect(verifyProof(reordered, resolve)).toBe(true);
    expect(verifyProof({ ...signed, credentialSubject: { name: 'Asha', count: 13 } }, resolve)).toBe(false);
    expect(verifyProof({ ...signed, proof: { ...signed.proof, created: '2027-01-01T00:00:00Z' } }, resolve)).toBe(false);
    expect(verifyProof({ ...signed, proof: { ...signed.proof, verificationMethod: 'did:web:evil.test#key-1' } }, resolve)).toBe(false);
    const other = loadSigningKey(generateSigningKey());
    expect(verifyProof(addProof(doc, other.privateKey, 'did:web:example.test#key-1'), resolve)).toBe(false);
    expect(() => loadSigningKey(require('node:crypto').generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }))).toThrow(/Ed25519/);
  });
  it('encodes a revocation status list with the left-most bit as index 0', () => {
    const list = encodeStatusList([0, 7, 94567]);
    expect(list.startsWith('u')).toBe(true);
    expect([0, 1, 7, 8, 94567, 94568, STATUS_LIST_BITS - 1].map(i => statusBit(list, i))).toEqual([true, false, true, false, true, false, false]);
    expect(() => statusBit(list, STATUS_LIST_BITS)).toThrow();
    expect(() => encodeStatusList([STATUS_LIST_BITS])).toThrow();
  });
});
