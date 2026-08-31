import type {Component} from 'solid-js'
import {A} from '@solidjs/router'

const Docs: Component = () => {
  return (
    <div id="docs" class="page">
      <h2>Documentation</h2>

      <figure class="docs-card">
        <h3>What LNURLwallet is</h3>
        <p>
          LNURLwallet is a static page with no backend, database or account
          system of its own. Everything it holds lives in your browser's local
          storage, and every network request it makes goes directly from your
          browser to the LNURLcash service that issued a note. One wallet holds
          notes from any number of independent services side by side.
        </p>
      </figure>

      <figure class="docs-card">
        <h3>
          LNURLcash bearer notes (
          <a
            href="https://github.com/lnurl/luds/blob/lnurlcash/25.md"
            target="_blank"
            rel="noreferrer"
          >
            LUD-25 draft
          </a>
          )
        </h3>
        <p>
          A bearer note is an ordinary{' '}
          <a
            href="https://github.com/lnurl/luds/blob/luds/03.md"
            target="_blank"
            rel="noreferrer"
          >
            LUD-03
          </a>{' '}
          withdrawRequest link whose <code>k1</code> <em>is</em> the asset:
        </p>
        <pre>{`lnurlw://mint.example/withdraw?k1=<secret>&amount=<msat>`}</pre>
        <p>
          Whoever knows the <code>k1</code> controls the sats behind it - like a
          banknote. The <code>amount</code> alongside it is just a claim by
          whoever encoded the note, so any recipient can display a value before
          contacting the service - it's untrusted until an online GET confirms
          it (or a signature backs it, see below). No new endpoint, no new
          encoding: a wallet that doesn't know LNURLcash just sees a normal
          withdraw link and can cash it out to a BOLT-11 invoice. A GET on the
          note's LNURL is purely <strong>informational</strong> - it reports the
          note's authoritative value (<code>maxWithdrawable</code>) and never
          burns anything, ignoring the URL's own <code>amount</code> claim. All
          mutating operations go to the <code>callback</code> from that
          response:
        </p>
        <pre>{`callback?k1=X&pr=<bolt11>                melt: X burned, pr (of exactly its value) paid
callback?k1=X&h=<sha256(X')>             rotate: X burned, a note keyed by h (same value) minted
callback?k1=X&amount=<msat>&h=..&h2=..   split: X burned, notes keyed by h (amount) + h2 (change) minted
callback?k1=X&k1=Y&h=<sha256(Z)>         merge: all burned, one note keyed by h (the sum) minted`}</pre>
        <p>
          For rotate/split/merge,{' '}
          <strong>this wallet generates the new note's secret itself</strong>,
          never the service - a fresh random 32-byte value, disclosed only as
          its hash (<code>h</code>, and <code>h2</code> for a split's change
          note). The service registers the note under that hash directly, so the
          response carries no <code>k1</code>/<code>change</code> at all, just{' '}
          <code>{`{"status":"OK"}`}</code> (plus <code>sig</code>/
          <code>sig2</code> if it signs - see Offline verification below). The
          service therefore never sees, generates, or persists the raw secret
          for these - closing the "prior holder" exposure a server-generated
          replacement would otherwise reopen on every single rotate.
        </p>
        <p>
          Melt only ever takes a single <code>k1</code> - to melt several notes
          in one payment, merge them first. Its <code>{`{"status":"OK"}`}</code>{' '}
          only means the payment is now on its way, not that the note is
          confirmed spent yet: the service pays it out asynchronously and only
          finalizes the burn once that settles, restoring the note if it fails
          instead. The wallet locks a just-melted note as spent right away
          rather than assume success.
        </p>
        <p>
          A service <strong>MAY</strong> attach a <strong>melt proof</strong> to
          that response: <code>pr</code> (the invoice this melt is paying,
          echoed back) and <code>verify</code>, a LUD-21-style URL reporting
          that outgoing payment's own settlement. Because a BOLT-11{' '}
          <code>pr</code> commits to{' '}
          <code>payment_hash = sha256(preimage)</code>, anyone holding both{' '}
          <code>pr</code> and the <code>preimage</code> <code>verify</code>{' '}
          eventually returns - not just the service - can independently confirm
          the melt happened. When a melt returns one, the wallet polls it (same
          cadence as its minting check) and treats a settled result as final:
          the note, already locked as spent, is confirmed gone. Without one, the
          note stays locked with no automatic way to learn its outcome - use
          "Unspend anyway" on the note's card if a payment ever turns out to
          have failed.
        </p>
        <ul>
          <li>
            <strong>Mint</strong>: a{' '}
            <a
              href="https://github.com/lnurl/luds/blob/luds/06.md"
              target="_blank"
              rel="noreferrer"
            >
              LUD-06
            </a>{' '}
            payRequest advertising <code>withdrawLink</code> mints notes. For
            every new note, this wallet requires <code>commentAllowed: 64</code>{' '}
            and sends the note's SHA-256 commitment as the callback{' '}
            <code>comment</code> and identical additive <code>h</code>. With a
            connected LNURLvault/Heartwood and a receipt-capable mint, the vault
            generates and retains the secret before the invoice exists. The
            wallet displays that invoice only after its quote commits the same
            hash and amount, then authenticates the settled note signature
            against the pinned mint key before confirming the device note. No
            secret export, import, or rotate occurs. The public recovery state
            is saved before the invoice QR appears, so a reload can safely
            resume. If that receipt extension is unavailable, a fresh invoice
            instead binds a seed-recoverable browser secret which is imported
            and rotated onto the connected vault after settlement. The payment
            preimage is proof, never the note. A mint without the mandatory
            comment capacity is refused before any invoice is created or paid.
            When an invoice advertises a{' '}
            <a
              href="https://github.com/lnurl/luds/blob/luds/21.md"
              target="_blank"
              rel="noreferrer"
            >
              LUD-21
            </a>{' '}
            verify URL, a "Check payment" button appears with a countdown and
            checks automatically every 5 seconds. A settled response is bound to
            the requested invoice; the wallet either validates the sealed
            receipt or claims with its already held browser secret. Any returned
            preimage remains ordinary payment proof. A mint MAY also withhold a
            fee on minting, advertised as an extra{' '}
            <code>Mint fees: base_msat,ppm</code> entry in the payRequest's
            metadata - when present, this wallet shows it and requests a bigger
            invoice so the note you end up holding still nets the amount you
            asked for.
          </li>
          <li>
            <strong>Melt</strong> has the service pay a bolt11 invoice of
            exactly the note's value - merge first to melt several at once.
          </li>
          <li>
            <strong>Split</strong> burns a note into two fresh ones - the amount
            you chose and the change.
          </li>
          <li>
            <strong>Combine</strong> merges selected same-service notes into
            one, in a single request.
          </li>
          <li>
            <strong>Receive</strong>: a scanned or pasted note is rotated
            immediately after the informational GET that verifies it - that GET
            already put the old secret on the wire, so whoever handed the note
            over needs burning out regardless of who they are.
          </li>
        </ul>
      </figure>

      <figure class="docs-card">
        <h3>Offline verification (optional)</h3>
        <p>
          A bearer note is otherwise an opaque secret - an offline recipient
          can't tell who issued it, by whom, or for how much, until they're back
          online and can ask the service directly. A service{' '}
          <strong>MAY</strong> close that gap by publishing a{' '}
          <code>mintPubkey</code> on its withdrawRequest response and signing
          each fresh secret's hash on rotate, split or merge (the{' '}
          <code>sig</code>/<code>sig2</code> in that callback's response - a
          freshly minted note has none until rotated once).
        </p>
        <p>
          The signature is made the same way{' '}
          <a
            href="https://github.com/lnurl/luds/blob/luds/13.md"
            target="_blank"
            rel="noreferrer"
          >
            LUD-13
          </a>{' '}
          signs its auth seed phrase - a Lightning node's own{' '}
          <code>signmessage</code>:
        </p>
        <pre>{`message = "LNURLcash:" || amount_msat (decimal) || ":" || h
digest  = sha256(sha256("Lightning Signed Message:" || message))`}</pre>
        <p>
          <code>h</code> here is exactly <code>hex(sha256(k1))</code> - the same
          hash this wallet already handed the service on the callback request
          for a new note, so the service signs precisely what it was given,
          never a secret it had to derive itself. The signature then travels
          alongside the note's own URL as one extra query parameter, ignored by
          wallets that don't check it:
        </p>
        <pre>{`lnurlw://mint.example/withdraw?k1=<secret>&amount=<msat>&sig=<hex>`}</pre>
        <p>
          When this wallet already knows a service's <code>mintPubkey</code>{' '}
          (learned from an earlier online check) and a note carries a{' '}
          <code>sig</code>, it recovers the signer from the two and compares it
          - a match shows as a "signed" badge on the note's card, entirely
          offline. This only proves the note <em>was issued</em> for that
          amount, never that it's still unspent - the only definitive check is
          an online rotate.
        </p>
        <p>
          Every <code>mintPubkey</code> this wallet has ever seen lives in the{' '}
          <A href="/mint">Trusted mints</A> section, at the bottom of the Mint
          page. The first time it sees a brand new one - looking a mint up,
          before minting anything from it - it asks whether to trust it;
          declining cancels that lookup. A mint you already hold a bearer note
          from is trusted automatically instead (holding funds there already
          implied trusting it) and can't be removed from the list; anything you
          added yourself - by confirming a lookup or typing it in directly - can
          be. The list travels with your <A href="/backup">backup</A> file, in
          plain (a signing key isn't a secret).
        </p>
      </figure>

      <figure class="docs-card">
        <h3>How your notes are stored: encrypted, locally</h3>
        <p>
          At setup the wallet generates a 12-word BIP39 seed phrase in your
          browser. From it a <strong>linking key</strong> is derived (the LUD-05
          derivation against the fixed domain <code>lnurlwallet</code>, the same
          scheme LNURLserver uses), and from the linking key an AES-256 key for
          storage.
        </p>
        <ul>
          <li>
            The <strong>seed phrase is never stored</strong> - write it down; it
            is the only way to recover the wallet on another device.
          </li>
          <li>
            Every <strong>bearer note is AES-GCM encrypted</strong> with the
            linking-key-derived key before it is written to local storage.
            Plaintext secrets never touch disk.
          </li>
          <li>
            The <strong>linking key itself is stored encrypted too</strong>:
            during setup you are asked for a password, and the key is saved as
            AES-GCM ciphertext under a PBKDF2 (210k iterations) stretch of that
            password. Unlocking decrypts it into memory only. (You can opt out,
            but then anyone using this browser profile can spend your notes.)
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
          <strong>all your bearer notes exactly as stored - encrypted</strong>.
          The file never contains a plaintext secret. If your linking key is
          password-encrypted, its ciphertext is included as well, so backup +
          password restores everything on a new device; if you opted out of the
          password, the key is excluded and the seed phrase is your recovery
          path.
        </p>
        <h3>Restore</h3>
        <p>
          Restoring merges the file's notes into local storage, skipping ones
          already present. Ciphertexts only become readable again once the same
          seed (and thus the same linking key) is active - restore order doesn't
          matter: seed first or file first both work.
        </p>
        <p class="warning">
          A backup protects against a lost device, not against theft of the note
          itself: the issuing service settles for whoever presents a k1 first.
          Rotation is your tool against stale copies - after restoring an old
          backup, refresh (rotate) anything you still hold.
        </p>
        <h3>Forget this wallet</h3>
        <p>
          The Backup page can also wipe this wallet from the device entirely -
          the linking key <em>and</em> every bearer note, after confirming.
          Unlike locking, this isn't undone by restoring the same seed
          afterward: the notes' ciphertext is deleted too, not just re-locked
          behind the key. Download a backup first if there's anything on this
          device worth keeping - it's the only way back.
        </p>
      </figure>

      <figure class="docs-card">
        <h3>Trust model</h3>
        <p>
          LNURLcash is custodial per service: the issuing service holds the
          actual sats and honors whoever bears the k1. This wallet spreads that
          trust across as many services as you like, keeps your copies encrypted
          at rest, and keeps secrets off the wire wherever the protocol allows -
          but it cannot make a service honest. Mint from services you trust.
        </p>
      </figure>
    </div>
  )
}
export default Docs
