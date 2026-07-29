import type {Component} from 'solid-js'
import {Show} from 'solid-js'
import {A} from '@solidjs/router'
import {
  IoCashSharp,
  IoLockClosedSharp,
  IoServerSharp,
  IoGitBranchSharp,
  IoSaveSharp
} from 'solid-icons/io'

export type HeroProps = {
  // 'welcome': no wallet on this device yet - lead to setup.
  // 'empty': wallet ready but holds no LNURLcash yet - lead to mint/scan/paste.
  mode: 'welcome' | 'empty'
}

const Hero: Component<HeroProps> = props => {
  return (
    <div id="hero" class="page">
      <section class="hero-intro">
        <Show
          when={props.mode === 'welcome'}
          fallback={
            <>
              <h1>No LNURLcash yet</h1>
              <p class="hero-subtitle">
                Your wallet is ready but empty. Mint a fresh bearer note from
                any LNURLcash mint, or bring one in by scanning or pasting a
                note someone handed you.
              </p>
              <div class="hero-actions">
                <A href="/mint" class="hero-btn hero-btn-primary">
                  Mint
                </A>
                <A href="/scan" class="hero-btn hero-btn-primary">
                  Scan
                </A>
                <A href="/paste" class="hero-btn hero-btn-primary">
                  Paste
                </A>
              </div>
            </>
          }
        >
          <h1>Your serverless LNURLcash wallet</h1>
          <p class="hero-subtitle">
            LNURLwallet is a static page with no backend of its own. It holds
            LNURLcash bearer notes - LNURL-withdraw links whose k1 is the asset
            - from any number of mints, encrypted with a key derived from your
            seed phrase and stored only in this browser's local storage.
          </p>
          <div class="hero-actions">
            <A href="/setup" class="hero-btn hero-btn-primary">
              Create wallet
            </A>
          </div>
        </Show>
      </section>
      <section class="hero-features">
        <div class="hero-feature">
          <IoCashSharp />
          <h3>Bearer notes (LUD-XX)</h3>
          <p>
            A note is a plain LNURL-withdraw link whose k1 is the asset -
            whoever holds it controls the sats. Any wallet can cash one out;
            this one can do much more.
          </p>
        </div>
        <div class="hero-feature">
          <IoLockClosedSharp />
          <h3>Encrypted at rest</h3>
          <p>
            Every note is AES-GCM encrypted with a key derived from your linking
            key before it touches local storage - and the linking key itself can
            be password-encrypted too.
          </p>
        </div>
        <div class="hero-feature">
          <IoServerSharp />
          <h3>Many mints, one wallet</h3>
          <p>
            Notes carry their issuing service with them, so one wallet holds
            LNURLcash from any number of independent mints side by side.
          </p>
        </div>
        <div class="hero-feature">
          <IoGitBranchSharp />
          <h3>Melt, split, transfer, combine</h3>
          <p>
            Melt a note into any bolt11 payment, split it into change, rotate
            its secret to hand it over safely, or merge same-mint notes into
            one.
          </p>
        </div>
        <div class="hero-feature">
          <IoSaveSharp />
          <h3>Backup &amp; restore</h3>
          <p>
            Download all your bearer notes as one file - still encrypted,
            exactly as stored. Restore them anywhere with your seed phrase.
          </p>
        </div>
      </section>
    </div>
  )
}
export default Hero
