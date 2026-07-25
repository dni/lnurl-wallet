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
        <pre>{`lnurlw://mint.example/withdraw?k1=<secret>&amount=<msat>`}</pre>
        <p>
          Whoever knows the <code>k1</code> controls the sats behind it -
          like a banknote. The <code>amount</code> alongside it is just a
          claim by whoever encoded the note, so any recipient can display a
          value before contacting the service - it's untrusted until an
          online GET confirms it (or a signature backs it, see below). No new
          endpoint, no new encoding: a wallet that doesn't know LNURLcash just
          sees a normal withdraw link and can cash it out to a BOLT-11
          invoice. A GET on the note's LNURL is purely{' '}
          <strong>informational</strong> - it reports the note's authoritative
          value (<code>maxWithdrawable</code>) and never burns anything,
          ignoring the URL's own <code>amount</code> claim. All mutating
          operations go to the <code>callback</code> from that response:
        </p>
        <pre>{`callback?k1=X&pr=<bolt11>    melt: X burned, pr (of exactly its value) paid
callback?k1=X                rotate: X burned, fresh k1' of same value returned
callback?k1=X&amount=<msat>  split: X burned, response carries k1 + change
callback?k1=X&k1=Y           merge: all burned, one note worth the sum returned`}</pre>
        <p>
          Melt only ever takes a single <code>k1</code> - to melt several
          notes in one payment, merge them first.
        </p>
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
            the preimage it reveals, and this wallet verifies it with the
            service and stores the note.
          </li>
          <li>
            <strong>Melt</strong> has the service pay a bolt11 invoice of
            exactly the note's value - merge first to melt several at once.
          </li>
          <li>
            <strong>Split</strong> burns a note into two fresh ones - the
            amount you chose and the change.
          </li>
          <li>
            <strong>Transfer</strong> rotates the secret: a fresh note to
            hand over, every old copy burned. The wallet also rotates
            automatically right after receiving a scanned or pasted note -
            the informational GET that verified it already put the old
            secret on the wire, so the previous holder's copy needs burning
            regardless of who they are.
          </li>
          <li>
            <strong>Combine</strong> merges selected same-service notes into
            one, in a single request.
          </li>
        </ul>
        <p>
          The optional <code>?id=sha256(k1)</code> hash lookup from earlier
          drafts of this spec was removed - every informational GET now puts
          the secret itself on the wire, which is exactly why the wallet
          treats one as exposure and rotates right after, per the spec's own
          guidance.
        </p>
      </figure>

      <figure class="docs-card">
        <h3>Offline verification (optional)</h3>
        <p>
          A bearer note is otherwise an opaque secret - an offline recipient
          can't tell who issued it or for how much. A service{' '}
          <strong>MAY</strong> make its notes verifiable by publishing a{' '}
          <code>mintPubkey</code> and signing each fresh secret it hands out
          (in the response to rotate, split or merge). The signature covers{' '}
          <code>sha256("LNURLcash/note" ‖ amount_msat ‖ sha256(k1))</code>{' '}
          and travels as one extra query parameter, ignored by wallets that
          don't check it:
        </p>
        <pre>{`lnurlw://mint.example/withdraw?k1=<secret>&amount=<msat>&sig=<hex>`}</pre>
        <p>
          When this wallet already knows a service's <code>mintPubkey</code>{' '}
          (learned from an earlier online check) and a note carries a{' '}
          <code>sig</code>, it recovers the signer from the two and compares
          it - a match shows as a "signed" badge on the note's card, entirely
          offline. This only proves the note <em>was issued</em> for that
          amount, never that it's still unspent - the only definitive check
          is an online rotate. <code>lnurl-mint</code> doesn't implement
          signing yet, so notes from it never show this badge.
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
