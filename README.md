# LNURLwallet

A wallet for **LNURLcash** bearer notes
([LUD-25 draft](https://github.com/lnurl/luds/blob/lnurlcash/25.md)). It is a
single static page - no backend, no database, no accounts - deployed
straight to GitHub Pages. Everything it holds lives **encrypted** in your
browser's local storage, and every network request goes directly from your
browser to the LNURLcash service that issued a note.

Built with the same stack as
[lnurl_server](https://github.com/dni/lnurl_server)'s frontend: Vite,
SolidJS, TypeScript, sass, `@scure`/`@noble` crypto, `solid-qr-code`,
`solid-toast`, `solid-icons`. Works against any spec-compliant service,
e.g. [lnurl-mint](https://github.com/dni/lnurl-mint).

## LNURLcash (LUD-25)

A bearer note is an ordinary [LUD-03](https://github.com/lnurl/luds/blob/luds/03.md)
withdrawRequest link whose `k1` **is** the asset:

```
lnurlw://mint.example/withdraw?k1=<secret>&amount=<msat>
```

Whoever knows the `k1` controls the sats behind it - like a banknote. The
`amount` alongside it is only a claim by whoever encoded the note (untrusted
until confirmed online, or backed by a signature - see below); the
authoritative value is always `maxWithdrawable` from an informational GET,
which the service ignores the URL's own `amount` for. No new endpoint, no
new encoding: a wallet that doesn't know LNURLcash sees a normal withdraw
link and can cash it out to a BOLT-11 invoice. That informational GET never
burns; all mutating operations go to the `callback` from that withdrawRequest
JSON:

| Request                                  | Result                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `callback?k1=X&pr=<bolt11>`              | **melt**: X burned once `pr` (of exactly its value) settles                    |
| `callback?k1=X&h=<sha256(X')>`           | **rotate**: X burned, a note keyed by `h` (worth the same) minted              |
| `callback?k1=X&amount=<msat>&h=..&h2=..` | **split**: X burned, notes keyed by `h` (`amount`) and `h2` (remainder) minted |
| `callback?k1=X&k1=Y&h=<sha256(Z)>`       | **merge**: all burned, one note keyed by `h`, worth the sum, minted            |

For rotate/split/merge, this wallet - not the service - generates every
replacement note's secret: a fresh random 32-byte value, disclosed only as
its hash (`h`, and `h2` for a split's change note). The service registers
the note under that hash directly and never sees, generates, or persists
the raw secret; the response for these carries no `k1`/`change` at all, just
`{"status":"OK"}` (plus `sig`/`sig2` if it signs - see Offline verification
below). This is what actually closes the "prior holder" exposure a
server-generated replacement would otherwise reopen on every single
rotate - a service-issued secret has, structurally, always been seen by
that service at least once; a wallet-generated one never is.

Melt only ever takes a single `k1` - merge several notes first to melt them
together in one payment. `{"status":"OK"}` from a melt only means the
payment is now on its way, not that the note is confirmed spent - the
service pays it out asynchronously and only finalizes the burn once that
settles, restoring the note if it fails instead (rejecting any other
callback naming that `k1` with `{"status":"ERROR","reason":"pending"}` in
the meantime). This wallet locks a just-melted note as spent right away
rather than assume success - refresh and further actions on it stay
disabled until you unspend it again, e.g. if the payment turns out to have
failed.

A service MAY additionally attach a **melt proof** to that response -
`pr` (the invoice this melt is paying, echoed back) and `verify`, a
[LUD-21](https://github.com/lnurl/luds/blob/luds/21.md)-style URL that
reports that outgoing payment's own settlement. Because a BOLT-11 `pr`
commits to `payment_hash = sha256(preimage)`, anyone holding both `pr` and
the `preimage` `verify` eventually returns - not just the service - can
independently confirm the melt actually happened, the same kind of proof
Offline verification gives a mint, but for the melt side. This wallet polls
`verify` (same 5s cadence as its minting check) whenever a melt returns
one, and treats a settled result as final confirmation the note is gone -
services that don't offer it leave the note simply locked as spent, with
no automatic way to learn its outcome beyond checking back later.

**Minting**: a [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md)
payRequest advertising `withdrawLink` mints notes. For new notes this wallet
requires `commentAllowed: 64` and sends the new note's SHA-256 commitment as
the callback `comment` (and the identical additive `h`). With a connected
LNURLvault and a receipt-capable mint, the vault creates and keeps
the secret `PENDING` before the invoice exists. The wallet refuses to display
that invoice until its quote commits the same hash and amount, then verifies
the settled receipt's note signature against the pinned mint key before
confirming the device note. The secret is never exported, imported, or
rotated. The public quote state is persisted before its QR is shown, so a
reload can resume against the hash exposed by `list_notes`.

Without that additive receipt, the compatible fallback chooses the secret
from the seed-derived browser cash ladder, persists its advanced index before
requesting a fresh invoice, then imports and rotates the bound note onto the
connected vault after settlement. In both paths the payment preimage proves
settlement but is not the note. Mints without the mandatory comment capacity
are refused before an invoice is created or paid. Manual preimage import
remains available only to recover legacy notes created elsewhere.

**Offline verification**: a service MUST publish a stable `mintPubkey` on
its withdrawRequest response and sign each fresh secret's hash on
rotate/split/merge (`sig`/`sig2` in the callback response - see above).
This lets a holder verify issuer and amount without a network round trip.
The key is controlled by the service. It SHOULD be the funding node identity
when that backend can produce a compatible signature, but MAY be a dedicated,
persistent secp256k1 key otherwise. A dedicated key proves issuance by the
pinned service, not by the Lightning node that funded it.

The signature uses the same digest wrapping as LUD-13:

```
message = "LNURLcash:" || amount_msat (decimal) || ":" || h
digest  = sha256(sha256("Lightning Signed Message:" || message))
```

`h` here is exactly `hex(sha256(k1))` - the same hash a wallet already
handed the service on the callback request for a new note, so the service
signs precisely what it was given, never a secret it had to derive (or,
under the old server-generates-the-secret scheme, already had in hand
regardless). It travels alongside a note's own URL as `&sig=<hex>`,
ignored by wallets that don't check it. This wallet verifies it whenever it
already knows a note's service pubkey and shows a "signed" badge on a
match - tolerating both the spec text's `r ‖ s ‖ recovery-id` (trailing)
wire layout and the recovery-id-leading layout at least one real
implementation has sent in the past, trying both rather than hard-failing
real notes over a byte-order mismatch. Signing keys are pinned to the
service's full origin, including scheme and port. They never rotate silently:
if a mint advertises a **different** key, the change is staged for review on
the Mints page, and the pinned key keeps deciding the badge until you
explicitly confirm it. An unsigned response cannot authorise its own
replacement. Confirming a rotation retires the old key outright - notes
signed under it stop verifying offline, and a single refresh re-signs them
under the new one.

The wallet follows the spec's security guidance:

- Every rotate/split/merge secret is **generated by this wallet, never the
  service** (see the callback table above) - the service is never a prior
  holder of it. Informational checks use `h=sha256(k1)` where supported,
  falling back to raw `k1` only when an older service explicitly requires it.
- A receipt-backed fresh mint is stronger with a vault connected: the
  **device generates and retains the secret before payment**, while the
  companion authenticates only its hash, amount, invoice and mint signature.
- Received (scanned/pasted) notes are **rotated immediately** after the
  informational GET that verifies them. The previous holder already knows the
  old secret, so their copy needs burning regardless of how the lookup ran.
- One wallet holds notes from **any number of independent mints** side by
  side, grouped per service; combine (merge) works across selected
  same-mint notes in a single request.

## Security model: encrypted with a key derived from your seed, in your local storage

- At setup a 12-word BIP39 **seed phrase** is generated in your browser. It
  is **never stored** - write it down; it is the only way to recover the
  wallet on another device.
- Every **bearer note is AES-256-GCM encrypted** with a key derived
  directly from the seed (sha256 over the BIP39 seed bytes plus a fixed
  context string) before it is written to local storage. Plaintext secrets
  never touch disk.
- That **derived encryption key is itself stored encrypted as well**
  (there is no separate identity keypair in between - see below): during
  setup you are asked for a password (8 characters minimum) and the key is
  saved as AES-GCM ciphertext under a PBKDF2 (210k iterations, SHA-256)
  stretch of that password. Unlocking decrypts it into memory only. Opting
  out is possible but leaves the key readable to anyone using the browser
  profile.
- The wallet sends nothing anywhere except the note operations you
  trigger, straight to the issuing service.

A wallet created before this scheme shipped instead derives its encryption
key through a LUD-05 linking keypair - an identity this wallet never
actually presents to any service, so the keypair was pure overhead for what
it was being used for. Those wallets keep working exactly as before (the
legacy derivation is still supported for unlocking), and the Backup page
offers a one-time **"Upgrade encryption"** action: re-enter your seed
phrase, and it re-encrypts every stored note and activity entry under the
simpler seed-direct key, then retires the old one. Nothing about the seed
phrase or the notes themselves changes, only how the encryption key is
derived.

## Backup & restore

**Backup** downloads a single JSON file with all your bearer notes exactly
as stored - **still encrypted**. If your encryption key is password-
encrypted, its ciphertext is included too (backup + password restores
everything on a new device); a plaintext-stored key is never exported, the
seed phrase is its recovery path.

**Restore** merges a backup file's notes into local storage, skipping ones
already present. Ciphertexts become readable once the same seed (hence the
same derived key) is active - restore the seed first or the file first,
either order works. Everything in the file is validated before anything is
installed: a malformed key record is skipped rather than planted, and a
restored key - encrypted or not - is never activated automatically, since
whoever wrote the file may know that key; the restore pauses on an
explicit source-trust warning first. Trusted mints come across unlocked
and **unconfirmed**: a file can neither pin a key change nor plant an
irremovable entry, and a file-sourced pin stays out of "signed"-badge
verification until a live response from that mint advertises the same key
(any refresh or lookup confirms it).

A backup protects against a lost device, not against theft of the note
itself: the service settles for whoever presents a `k1` first. Rotation
(each note's own Refresh action, and the automatic rotate-on-receive) is
the tool against stale copies - after restoring an old backup, refresh
what you hold.

## Note on lnurl-mint

[lnurl-mint](https://github.com/dni/lnurl-mint) tracks this spec closely and
implements mandatory offline verification through the funding node's
`signmessage` support for lnd/cln or a persistent seed-derived SERVICE key for
Spark, and melt proof
(`pr`/`verify` on a melt's response) when its `VERIFY_ENABLED` setting is
on - the same toggle that gates advertising a mint invoice's own `verify`
URL. Its `sign_note`
used to send the recovery-id-leading byte layout rather than the spec
text's trailing one; that's since been fixed to send the spec's `r ‖ s ‖
recovery-id` layout directly (this wallet's dual-order tolerance - see
Offline verification above - is kept anyway, as a hedge for other
implementations). Its melt used to be synchronous (the HTTP response
didn't return until the outgoing payment had already settled or
confirmably failed); as of `fix: immediatly return on melt` it now responds
immediately and pays out asynchronously in the background instead, matching
the spec's async pending window rather than a stricter special case of it.

## Development

```sh
npm install
npm run dev     # dev server on :3000
npm test        # vitest (codec + crypto round-trips)
npm run tsc     # typecheck
npm run build   # static build in dist/
```

For an end-to-end local loop, run [lnurl-mint](https://github.com/dni/lnurl-mint)
(`uv run fastapi dev lnurl_mint/server.py`) and point the Mint page at
`localhost:8000` - insecure hosts (localhost, 127.0.0.1, .onion) are
resolved as http automatically.

## Deployment

Pushing a version tag (e.g. `git tag v0.1.0 && git push origin v0.1.0`) runs
tests and deploys `dist/` to **GitHub Pages** via
`.github/workflows/deploy.yml` (enable Pages -> "GitHub Actions" as the
source in the repo settings). A plain push to `main` no longer deploys -
`ci.yml` still runs tests/build on every push and PR, it just doesn't
publish. The build uses relative asset paths and a hash router, so it works
from any subpath - no server configuration needed. The displayed version
(footer) is read straight from the nearest git tag at build time (see
`scripts/git-version.mjs`), not a hand-bumped `package.json` field.

Once that deploy succeeds, the same workflow's `release` job creates a
**GitHub Release** for the tag (`gh release create --generate-notes`), with
its changelog auto-generated from the commits/PRs merged since the previous
tag - nothing to write by hand. The release also carries the exact `dist/`
that got published, packaged as `lnurl-wallet-vX.Y.Z.tar.gz`, alongside a
`.sha256` file for verifying it - a static-hosting-independent way to fetch
and confirm a given version's build artifact.

## License

MIT
