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
          makes goes directly from your browser to the LNURLcash service that
          issued a note. One wallet holds notes from any number of
          independent services side by side.
        </p>
      </figure>

      <figure class="docs-card">
        <h3>
          LNURLcash bearer notes (
          <a
            href="https://github.com/lnurl/luds/blob/luds/XX.md"
            target="_blank"
          >
            LUD-XX draft
          </a>
          )
        </h3>
        <p>
          A bearer note is an ordinary{' '}
          <a
            href="https://github.com/lnurl/luds/blob/luds/03.md"
            target="_blank"
          >
            LUD-03
          </a>{' '}
          withdrawRequest link whose <code>k1</code> <em>is</em> the asset:
        </p>
        <pre>{`lnurlw://mint.example/withdraw?k1=<secret>`}</pre>
        <p>
          Whoever knows the <code>k1</code> controls the sats behind it -
          like a banknote. No new endpoint, no new encoding: a wallet that
          doesn't know LNURLcash just sees a normal withdraw link and can
          cash it out to a BOLT-11 invoice. A GET on the note's LNURL is
          purely <strong>informational</strong> - it reports the note's value
          (<code>maxWithdrawable</code>) and never burns anything. All
          mutating operations go to the <code>callback</code> from that
          response:
        </p>
        <pre>{`callback?k1=X&pr=<bolt11>      melt: X burned, pr (of exactly its value) paid
callback?k1=X&k1=Y&pr=...      merged melt: all burned, pr of combined value paid
callback?k1=X                  rotate: X burned, fresh k1' of same value returned
callback?k1=X&amount=<msat>    split: X burned, response carries k1 + change
callback?k1=X&k1=Y             merge: all burned, one note worth the sum returned`}</pre>
        <ul>
          <li>
            <strong>Mint</strong>: a{' '}
            <a
              href="https://github.com/lnurl/luds/blob/luds/06.md"
              target="_blank"
            >
              LUD-06
            </a>{' '}
            payRequest advertising <code>withdrawLink</code> mints notes -
            the <strong>payment preimage</strong> of its paid invoice is the
            bearer secret. Pay the invoice with any Lightning wallet, paste
            the preimage it reveals, and{' '}
            <code>withdrawLink?k1=&lt;preimage&gt;</code> is your note.
          </li>
          <li>
            <strong>Melt</strong> has the service pay a bolt11 invoice of
            exactly the note's value - split first to melt less.
          </li>
          <li>
            <strong>Split</strong> burns a note into two fresh ones - the
            amount you chose and the change.
          </li>
          <li>
            <strong>Transfer</strong> rotates the secret: a fresh note to
            hand over, every old copy burned. The wallet also rotates
            automatically right after receiving a scanned or pasted note, so
            the previous holder can't double-spend it.
          </li>
          <li>
            <strong>Combine</strong> merges selected same-service notes into
            one, in a single request.
          </li>
        </ul>
        <p>
          When a service supports it (like{' '}
          <a href="https://github.com/dni/lnurl-mint" target="_blank">
            lnurl-mint
          </a>
          ), the wallet checks a note's value with{' '}
          <code>?id=sha256(k1)</code> instead of <code>?k1=</code> - the
          secret then never goes on the wire for lookups; it is transmitted
          exactly once, in the callback request that burns it.
        </p>
      </figure>

      <figure class="docs-card">
        <h3>How your notes are stored: encrypted, locally</h3>
        <p>
          At setup the wallet generates a 12-word BIP39 seed phrase in your
          browser. From it a <strong>linking key</strong> is derived (the
          LUD-05 derivation against the fixed domain <code>lnurlwallet</code>
          , the same scheme LNURLserver uses), and from the linking key an
          AES-256 key for storage.
        </p>
        <ul>
          <li>
            The <strong>seed phrase is never stored</strong> - write it down;
            it is the only way to recover the wallet on another device.
          </li>
          <li>
            Every <strong>bearer note is AES-GCM encrypted</strong> with the
            linking-key-derived key before it is written to local storage.
            Plaintext secrets never touch disk.
          </li>
          <li>
            The <strong>linking key itself is stored encrypted too</strong>:
            during setup you are asked for a password, and the key is saved
            as AES-GCM ciphertext under a PBKDF2 (210k iterations) stretch of
            that password. Unlocking decrypts it into memory only. (You can
            opt out, but then anyone using this browser profile can spend
            your notes.)
          </li>
          <li>
            Nothing is ever sent anywhere except the note operations you
            trigger, straight to the issuing service.
          </li>
        </ul>
      </figure>

      <figure class="docs-card">
        <h3>Backup</h3>
        <p>
          The Backup page downloads a single JSON file containing{' '}
          <strong>all your bearer notes exactly as stored - encrypted</strong>
          . The file never contains a plaintext secret. If your linking key
          is password-encrypted, its ciphertext is included as well, so
          backup + password restores everything on a new device; if you opted
          out of the password, the key is excluded and the seed phrase is
          your recovery path.
        </p>
        <h3>Restore</h3>
        <p>
          Restoring merges the file's notes into local storage, skipping ones
          already present. Ciphertexts only become readable again once the
          same seed (and thus the same linking key) is active - restore order
          doesn't matter: seed first or file first both work.
        </p>
        <p class="warning">
          A backup protects against a lost device, not against theft of the
          note itself: the issuing service settles for whoever presents a
          k1 first. Rotation is your tool against stale copies - after
          restoring an old backup, transfer (rotate) anything you still hold.
        </p>
      </figure>

      <figure class="docs-card">
        <h3>Trust model</h3>
        <p>
          LNURLcash is custodial per service: the issuing service holds the
          actual sats and honors whoever bears the k1. This wallet spreads
          that trust across as many services as you like, keeps your copies
          encrypted at rest, and keeps secrets off the wire wherever the
          protocol allows - but it cannot make a service honest. Mint from
          services you trust.
        </p>
      </figure>
    </div>
  )
}
export default Docs
