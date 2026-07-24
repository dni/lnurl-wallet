import type {Component} from 'solid-js'

const Docs: Component = () => {
  return (
    <div id="docs" class="page">
      <h2>Documentation</h2>

      <figure class="docs-card">
        <h3>What LNURLwallet is</h3>
        <p>
          LNURLwallet is <strong>serverless</strong>: a static page with no
          backend, database or account system of its own. Everything it holds
          lives in your browser's local storage, and every network request it
          makes goes directly from your browser to the LNURLcash server that
          issued a token. It can hold LNURLcash from any number of independent
          servers side by side.
        </p>
      </figure>

      <figure class="docs-card">
        <h3>LNURLcash bearer tokens</h3>
        <p>
          An LNURLcash token is a <strong>bearer instrument</strong>: in
          LUD-01 spirit it is a bech32-encoded URL, prefixed{' '}
          <code>lnurlcash1</code>, whose path embeds a secret. Whoever knows
          the URL controls the sats behind it - like a banknote. The wallet
          talks to the issuing server with plain GETs on that URL:
        </p>
        <pre>{`GET url                                  -> {tag: "cashRequest", amount, pending?}
GET url?action=melt&pr={bolt11}          -> {status: "OK"}
GET url?action=split&amount={msat}       -> {tokens: [t1, t2]}
GET url?action=transfer                  -> {token}
GET url?action=combine&tokens={t2,t3..}  -> {token}
GET {server}/lnurlcash/mint?amount=msat  -> {token, pr}`}</pre>
        <ul>
          <li>
            <strong>Mint</strong> asks a server for a fresh bearer - it comes
            back with a bolt11 invoice and stays <em>pending</em> until that
            invoice is paid.
          </li>
          <li>
            <strong>Melt</strong> spends the bearer by having its server pay a
            bolt11 invoice you provide.
          </li>
          <li>
            <strong>Split</strong> exchanges one bearer for two fresh ones -
            the amount you chose and the remainder.
          </li>
          <li>
            <strong>Transfer</strong> rotates the bearer secret: you get a
            fresh token to hand over and every old copy becomes worthless -
            do this whenever you receive or give away a token, so no previous
            holder retains a spendable copy.
          </li>
          <li>
            <strong>Combine</strong> merges several bearers of the same server
            into a single fresh one.
          </li>
        </ul>
      </figure>

      <figure class="docs-card">
        <h3>How your tokens are stored: encrypted, locally</h3>
        <p>
          At setup the wallet generates a 12-word BIP39 seed phrase in your
          browser. From it a <strong>linking key</strong> is derived (the
          LUD-05 derivation against the fixed domain{' '}
          <code>lnurlwallet</code>, the same scheme LNURLserver uses), and
          from the linking key an AES-256 key for storage.
        </p>
        <ul>
          <li>
            The <strong>seed phrase is never stored</strong> - write it down;
            it is the only way to recover the wallet on another device.
          </li>
          <li>
            Every <strong>bearer token is AES-GCM encrypted</strong> with the
            linking-key-derived key before it is written to local storage.
            Plaintext tokens never touch disk.
          </li>
          <li>
            The <strong>linking key itself is stored encrypted too</strong>:
            during setup you are asked for a password, and the key is saved as
            AES-GCM ciphertext under a PBKDF2 (210k iterations) stretch of
            that password. Unlocking decrypts it into memory only. (You can
            opt out, but then anyone using this browser profile can spend your
            LNURLcash.)
          </li>
          <li>
            Nothing is ever sent anywhere except the token operations you
            trigger, straight to the issuing server.
          </li>
        </ul>
      </figure>

      <figure class="docs-card">
        <h3>Backup</h3>
        <p>
          The Backup page downloads a single JSON file containing{' '}
          <strong>all your bearer tokens exactly as stored - encrypted</strong>
          . The file never contains a plaintext token. If your linking key is
          password-encrypted, its ciphertext is included as well, so backup +
          password restores everything on a new device; if you opted out of
          the password, the key is excluded and the seed phrase is your
          recovery path.
        </p>
        <h3>Restore</h3>
        <p>
          Restoring merges the file's bearers into local storage, skipping
          ones already present. Ciphertexts only become readable again once
          the same seed (and thus the same linking key) is active - restore
          order doesn't matter: seed first or file first both work.
        </p>
        <p class="warning">
          A backup protects against a lost device, not against theft of the
          token itself: LNURLcash is a bearer instrument, and the issuing
          server can always settle it for whoever presents it first. Transfer
          (secret rotation) is your tool against stale copies.
        </p>
      </figure>

      <figure class="docs-card">
        <h3>Trust model</h3>
        <p>
          LNURLcash is custodial per server: the issuing server holds the
          actual sats and honors whoever bears the token. This wallet spreads
          that trust across as many servers as you like, keeps your copies
          encrypted at rest, and never lets a token or key leave your browser
          unencrypted - but it cannot make a server honest. Mint from servers
          you trust.
        </p>
      </figure>
    </div>
  )
}
export default Docs
