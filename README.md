# LNURLwallet

A **serverless** wallet for **LNURLcash** bearer tokens. It is a single
static page - no backend, no database, no accounts - deployed straight to
GitHub Pages. Everything it holds lives **encrypted** in your browser's
local storage, and every network request goes directly from your browser to
the LNURLcash server that issued a token.

Built with the same stack as
[lnurl_server](https://github.com/dni/lnurl_server)'s frontend: Vite,
SolidJS, TypeScript, sass, `@scure`/`@noble` crypto, `solid-qr-code`,
`solid-toast`, `solid-icons`.

## LNURLcash

An LNURLcash token is a **bearer instrument**: in LUD-01 spirit it is a
bech32-encoded URL prefixed `lnurlcash1`, whose path embeds a secret
(`https://server/lnurlcash/{secret}`). Whoever knows the URL controls the
sats behind it - like a banknote. The issuing server holds the actual sats
and honors whoever presents the token.

The wallet speaks to servers with plain GETs on the token URL (errors follow
the LNURL `{"status": "ERROR", "reason": ...}` convention):

| Operation | Request | Response |
|-----------|---------|----------|
| status    | `GET url` | `{"tag": "cashRequest", "amount": <msat>, "pending"?: bool}` |
| melt      | `GET url?action=melt&pr={bolt11}` | `{"status": "OK"}` |
| split     | `GET url?action=split&amount={msat}` | `{"tokens": [t1, t2]}` |
| transfer  | `GET url?action=transfer` | `{"token": t}` (secret rotated) |
| combine   | `GET url?action=combine&tokens={t2,t3,..}` | `{"token": t}` |
| mint      | `GET {server}/lnurlcash/mint?amount={msat}` | `{"token": t, "pr": bolt11}` |

One wallet holds tokens from **any number of independent servers** side by
side, grouped per server. Per bearer you can **melt** (have the server pay a
bolt11 invoice), **split** (exchange for two fresh tokens), **transfer**
(rotate the secret so every old copy becomes worthless, then hand the fresh
token over), and **combine** selected same-server bearers into one.

## Security model: encrypted with your linking key, in your local storage

- At setup a 12-word BIP39 **seed phrase** is generated in your browser. It
  is **never stored** - write it down; it is the only way to recover the
  wallet on another device.
- From the seed a **linking key** is derived using the LUD-05 derivation
  (same scheme as lnurl_server) against the fixed domain `lnurlwallet`, so
  the identity is independent of where this page is hosted.
- Every **bearer token is AES-256-GCM encrypted** with a key derived from
  the linking key before it is written to local storage. Plaintext tokens
  never touch disk.
- The **linking key itself is stored encrypted as well**: during setup you
  are asked for a password and the key is saved as AES-GCM ciphertext under
  a PBKDF2 (210k iterations, SHA-256) stretch of that password. Unlocking
  decrypts it into memory only. Opting out is possible but leaves the key
  readable to anyone using the browser profile.
- The wallet sends nothing anywhere except the token operations you
  trigger, straight to the issuing server.

## Backup & restore

**Backup** downloads a single JSON file with all your bearer tokens exactly
as stored - **still encrypted**. If the linking key is password-encrypted,
its ciphertext is included too (backup + password restores everything on a
new device); a plaintext-stored linking key is never exported, the seed
phrase is its recovery path.

**Restore** merges a backup file's bearers into local storage, skipping ones
already present. Ciphertexts become readable once the same seed (hence the
same linking key) is active - restore the seed first or the file first,
either order works.

A backup protects against a lost device, not against theft of the token
itself: the server settles for whoever presents a bearer first. Use
**transfer** (secret rotation) after receiving a token so no previous holder
retains a spendable copy.

## Development

```sh
npm install
npm run dev     # dev server on :3000
npm test        # vitest (codec + crypto round-trips)
npm run tsc     # typecheck
npm run build   # static build in dist/
```

## Deployment

Pushing to `main` runs tests and deploys `dist/` to **GitHub Pages** via
`.github/workflows/deploy.yml` (enable Pages -> "GitHub Actions" as the
source in the repo settings). The build uses relative asset paths and a hash
router, so it works from any subpath - no server configuration needed.

## License

MIT
