# LNURLwallet

A wallet for **LNURLcash** bearer notes
([LUD-XX draft](https://github.com/lnurl/luds/blob/663264923edf3e8e8fc22835a68ef98238b8d692/XX.md)). It is a
single static page - no backend, no database, no accounts - deployed
straight to GitHub Pages. Everything it holds lives **encrypted** in your
browser's local storage, and every network request goes directly from your
browser to the LNURLcash service that issued a note.

Built with the same stack as
[lnurl_server](https://github.com/dni/lnurl_server)'s frontend: Vite,
SolidJS, TypeScript, sass, `@scure`/`@noble` crypto, `solid-qr-code`,
`solid-toast`, `solid-icons`. Works against any spec-compliant service,
e.g. [lnurl-mint](https://github.com/dni/lnurl-mint).

## LNURLcash (LUD-XX)

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

| Request                       | Result                                                         |
| ----------------------------- | -------------------------------------------------------------- |
| `callback?k1=X&pr=<bolt11>`   | **melt**: X burned once `pr` (of exactly its value) settles    |
| `callback?k1=X`               | **rotate**: X burned, `{"status":"OK","k1":X'}` same value     |
| `callback?k1=X&amount=<msat>` | **split**: X burned, response carries `k1` (amount) + `change` |
| `callback?k1=X&k1=Y`          | **merge**: all burned, one note worth the sum returned         |

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

**Minting**: a [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md)
payRequest advertising `withdrawLink` mints notes - the **payment
preimage** of its paid invoice becomes a valid `k1` at that endpoint. This
wallet has no Lightning node of its own, so you pay the invoice with any
wallet and paste back the preimage it reveals; the wallet verifies it with
the service, then immediately rotates it - that verifying GET already put
the preimage on the wire - before storing the note, same as it does for a
scanned or pasted note.

**Offline verification (optional)**: a service MAY publish a `mintPubkey`
on its withdrawRequest response and sign each fresh secret it hands out (on
rotate/split/merge), letting a holder verify issuer and amount without a
network round trip. The signature is made the same way LUD-13 signs its
auth seed phrase - a Lightning node's own `signmessage`:

```
message = "LNURLcash:" || amount_msat (decimal) || ":" || hex(sha256(k1))
digest  = sha256(sha256("Lightning Signed Message:" || message))
```

and travels as one more query param, `&sig=<hex>`, ignored by wallets that
don't check it. This wallet verifies it whenever it already knows a note's
service pubkey and shows a "signed" badge on a match - tolerating both the
spec text's `r ‖ s ‖ recovery-id` (trailing) wire layout and the
recovery-id-leading layout at least one real implementation has sent in the
past, trying both rather than hard-failing real notes over a byte-order
mismatch.

The wallet follows the spec's security guidance:

- Received (scanned/pasted) notes are **rotated immediately** after the
  informational GET that verifies them - that GET necessarily puts the old
  secret on the wire, so the previous holder's copy needs burning regardless
  of who they are.
- One wallet holds notes from **any number of independent mints** side by
  side, grouped per service; combine (merge) works across selected
  same-mint notes in a single request.

## Security model: encrypted with your linking key, in your local storage

- At setup a 12-word BIP39 **seed phrase** is generated in your browser. It
  is **never stored** - write it down; it is the only way to recover the
  wallet on another device.
- From the seed a **linking key** is derived using the LUD-05 derivation
  (same scheme as lnurl_server) against the fixed domain `lnurlwallet`, so
  the identity is independent of where this page is hosted.
- Every **bearer note is AES-256-GCM encrypted** with a key derived from
  the linking key before it is written to local storage. Plaintext secrets
  never touch disk.
- The **linking key itself is stored encrypted as well**: during setup you
  are asked for a password and the key is saved as AES-GCM ciphertext under
  a PBKDF2 (210k iterations, SHA-256) stretch of that password. Unlocking
  decrypts it into memory only. Opting out is possible but leaves the key
  readable to anyone using the browser profile.
- The wallet sends nothing anywhere except the note operations you
  trigger, straight to the issuing service.

## Backup & restore

**Backup** downloads a single JSON file with all your bearer notes exactly
as stored - **still encrypted**. If the linking key is password-encrypted,
its ciphertext is included too (backup + password restores everything on a
new device); a plaintext-stored linking key is never exported, the seed
phrase is its recovery path.

**Restore** merges a backup file's notes into local storage, skipping ones
already present. Ciphertexts become readable once the same seed (hence the
same linking key) is active - restore the seed first or the file first,
either order works.

A backup protects against a lost device, not against theft of the note
itself: the service settles for whoever presents a `k1` first. Rotation
(each note's own Refresh action, and the automatic rotate-on-receive) is
the tool against stale copies - after restoring an old backup, refresh
what you hold.

## Note on lnurl-mint

[lnurl-mint](https://github.com/dni/lnurl-mint) tracks this spec closely and
implements offline verification when a funding source is configured
(`mintPubkey` + signing via the node's own `signmessage`). Its `sign_note`
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

## License

MIT
