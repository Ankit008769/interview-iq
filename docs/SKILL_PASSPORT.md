# Skill passport (Phase E4, v1)

Implemented 11 November 2026. A candidate can turn chosen parts of their practice into a signed, revocable
credential. They share it as a link or a JSON file. Anyone can check that Interview IQ issued it, that
nothing in it was changed, and that the holder has not revoked it.

Every passport says, in the credential itself and on every page that shows it, that it is a **practice
record and not a hiring score**.

## Roadmap items and status

| Roadmap item | v1 |
|---|---|
| Signed, revocable W3C Verifiable Credentials for practice achievements | Yes, as the next section describes. |
| Explicit "practice record, not a hiring score" labelling | Yes. It is in the credential's `description` and shown on the holder's page, the public page and every verification response. |
| User-controlled sharing | Yes. The holder chooses which achievements to include and whether to show their name. They share an unguessable link or the JSON file, and can revoke it at any time. |
| Cloud KMS signing keys | Not yet. The key comes from `PASSPORT_SIGNING_KEY` (store it in Secret Manager). Signing is one `sign()` call, so moving to Cloud KMS Ed25519 keys changes only that call. KMS needs the staging project's billing. |
| Exit gate: 3 campus or employer partners accept the passport as a supplementary signal | Needs partners: a business task for the owner. |

### The credential format

| Part | Standard |
|---|---|
| Credential | Verifiable Credentials Data Model 2.0, type `InterviewPracticeRecord`, valid for a year |
| Proof | Data Integrity `eddsa-jcs-2022`: JSON Canonicalization (RFC 8785), then SHA-256, then Ed25519 |
| Issuer | `did:web` with a `Multikey` public key |
| Revocation | Bitstring Status List v1.0 |

## What a passport can include

Everything is computed on the server from the holder's own records at the moment of issue. The holder
cannot type anything into it.

| Achievement | Content | Rule |
|---|---|---|
| AI-scored mock interviews | Number completed, by type | Only interviews with AI feedback count; practice-bank interviews do not |
| Skill levels | Skill, area, level and the likely range (95% interval) | Only skills at Proficient or Strong whose estimate is confident: standard deviation at most 0.8 |
| Coding problems solved | Distinct problems with an accepted submission, by difficulty | Tests run in the sandboxed runner |
| System designs reviewed | Number reviewed and the mean rubric score (0–5) | Mean of the criteria that had verified evidence |

Each achievement states its method. The holder's name is left out unless they tick "Show my name on it".

## How it works

### Issuer

`PASSPORT_ISSUER_HOST` (for example the app's host name) and `PASSPORT_SIGNING_KEY` (an Ed25519 PKCS#8 PEM)
switch the feature on.

- **DID.** The issuer is `did:web:<host>`.
- **DID document.** It is served at `/.well-known/did.json`, with one `Multikey` verification method,
  `#key-1`, used for `assertionMethod`.

### Signing

The proof's options and the credential are canonicalized separately, hashed and concatenated (options
first), then signed. `proofValue` is base58btc multibase.

### Revocation

Each passport gets a random free index in a status list of 131,072 entries. That is the specification's
minimum, so checking one passport does not reveal which one it is.

- **Revoking** sets the passport's bit. The public page then shows only that it was revoked.
- **Status list.** `GET /api/passport/status/1` serves the list as a signed `BitstringStatusListCredential`:
  GZIP, then base64url multibase, with the left-most bit as index 0.

### Verifying

`POST /api/passport/verify` (public, rate-limited per IP) accepts any passport JSON. It checks:
- the issuer;
- the proof, against the issuer's key;
- the validity period;
- the status bit.

The public page `/passport/:id` shows the same result in plain words.

### Limits

- **Active passports.** A holder can keep up to 10 active passports and create up to 10 a day.
- **Links.** Share links carry 128 random bits.

## Privacy

| Question | Answer |
|---|---|
| Shown to others | Only what the holder put in the passport: no answers, scores per question, recordings, code, documents or email address. The name is shown only if chosen. |
| Revocation | The public page stops showing the content at once. Copies of the JSON already given out remain, but verify as revoked. |
| Account deletion | Each passport's content and link to the person are removed, keeping only its status index, marked revoked, so copies given out verify as revoked. The same happens when a backup is restored. |
| Export | The account export includes the holder's passports. |

## Tests

| File | What it covers |
|---|---|
| `server/tests/passport-crypto.test.ts` | RFC 8785 canonicalization (including the RFC's number and key-order examples); base58btc against the reference vector; that every Ed25519 Multikey starts `z6Mk`; sign and verify, including reordered keys (still valid) and any change to the content, the proof, the key or the method (invalid); status-list bit order and bounds |
| `server/tests/passport.test.ts` | Off without a key; what can be included (uncertain and weak skills are left out); issuing only the chosen achievements, with and without the name; the DID document verifying the proof; public verification, including a tampered copy; the public page; holder-only download and revocation; the revoked bit in the signed status list; the export; deletion on backup restore |
| `server/e2e/passport.spec.ts` | Creating a passport in the UI and opening its public page |

**Not yet done:** an interoperability check against another implementation's `eddsa-jcs-2022` test
vectors, and alignment with the Open Badges 3.0 achievement profile, which some partners may prefer.
