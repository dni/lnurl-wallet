import {For} from 'solid-js'
import {AiFillGithub} from 'solid-icons/ai'
import {IoLockClosedSharp, IoGlobeSharp} from 'solid-icons/io'
import {A} from '@solidjs/router'

// the LUDs this wallet actually speaks: bech32 encoding, withdrawRequest,
// seed derivation, payRequest, disposable/storeable links, Lightning
// Address, raw schemes, verify, LNURLcash
const LUD_TITLES: Record<string, string> = {
  '01': 'Base LNURL encoding and informational payloads',
  '03': 'withdrawRequest base spec',
  '05': 'BIP32-based seed generation for auth protocol',
  '06': 'payRequest base spec',
  '11': 'Disposable and storeable payRequests',
  '16': 'Paying to static internet identifiers (Lightning Address)',
  '17': 'Protocol schemes and raw (non bech32-encoded) URLs',
  '21': 'verify base spec - also LUD-25 melt proof',
  '25': 'LNURLcash - bearer assets (draft)'
}

// plain Object.keys order is wrong here: JS enumerates canonical-integer
// string keys ('16', '17') ascending before any other string keys, so
// leading-zero ones ('01', '03'...) would trail behind them instead of
// sorting in - explicit numeric sort (every key here is numeric, but kept
// generic rather than assuming that stays true forever)
const luds = Object.keys(LUD_TITLES).sort((a, b) => {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isNaN(na)) return Number.isNaN(nb) ? a.localeCompare(b) : 1
  if (Number.isNaN(nb)) return -1
  return na - nb
})

// LUD-25 is still a draft living on the lnurlcash branch of the luds repo
// (lnurl/luds#301) - it has no file on the merged luds branch yet
const ludHref = (lud: string) =>
  `https://github.com/lnurl/luds/blob/${lud === '25' ? 'lnurlcash' : 'luds'}/${lud}.md`

const Footer = () => {
  return (
    <footer class="footer">
      {/* grouped as one line even on mobile (where every top-level
      .footer-item otherwise gets its own line) - version/Website/Github
      read fine together, unlike the longer privacy note and LUD list
      below them */}
      <div class="footer-item footer-row">
        <span class="footer-row-item">LNURLwallet {__APP_VERSION__}</span>
        <a
          class="footer-row-item"
          href="https://lnurlcash.com"
          target="_blank"
          rel="noreferrer"
        >
          <IoGlobeSharp />
          &nbsp;Website
        </a>
        <a
          class="footer-row-item"
          href="https://github.com/dni/lnurl-wallet"
          target="_blank"
          rel="noreferrer"
        >
          <AiFillGithub />
          &nbsp;Github
        </a>
      </div>
      <A class="footer-item" href="/docs">
        <IoLockClosedSharp />
        &nbsp;keys never leave your browser
      </A>
      <span class="footer-item">
        <span>LUDs:&nbsp;</span>
        <For each={luds}>
          {lud => (
            <>
              <a
                href={ludHref(lud)}
                target="_blank"
                rel="noreferrer"
                title={LUD_TITLES[lud]}
              >
                {lud}
              </a>
              &nbsp;
            </>
          )}
        </For>
      </span>
    </footer>
  )
}
export default Footer
