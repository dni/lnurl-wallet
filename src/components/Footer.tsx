import {For} from 'solid-js'
import {AiFillGithub} from 'solid-icons/ai'
import {IoLockClosedSharp} from 'solid-icons/io'
import {A} from '@solidjs/router'

// the LUDs this wallet actually speaks: bech32 encoding, withdrawRequest,
// seed derivation, payRequest, Lightning Address, raw schemes, LNURLcash
const LUD_TITLES: Record<string, string> = {
  '01': 'Base LNURL encoding and informational payloads',
  '03': 'withdrawRequest base spec',
  '05': 'BIP32-based seed generation for auth protocol',
  '06': 'payRequest base spec',
  '16': 'Paying to static internet identifiers (Lightning Address)',
  '17': 'Protocol schemes and raw (non bech32-encoded) URLs',
  XX: 'LNURLcash - bearer assets (draft)'
}

// plain Object.keys order is wrong here: JS enumerates canonical-integer
// string keys ('16', '17') ascending before any other string keys, so
// leading-zero ones ('01', '03'...) would trail behind them instead of
// sorting in - explicit numeric sort, with the non-numeric 'XX' draft last
const luds = Object.keys(LUD_TITLES).sort((a, b) => {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isNaN(na)) return Number.isNaN(nb) ? a.localeCompare(b) : 1
  if (Number.isNaN(nb)) return -1
  return na - nb
})

const Footer = () => {
  return (
    <footer class="footer">
      <span class="footer-item">LNURLwallet v{__APP_VERSION__}</span>
      <a
        class="footer-item"
        href="https://github.com/dni/lnurl-wallet"
        target="_blank"
      >
        <AiFillGithub />
        &nbsp;Github
      </a>
      <A class="footer-item" href="/docs">
        <IoLockClosedSharp />
        &nbsp;serverless&nbsp;·&nbsp;keys never leave your browser
      </A>
      <span class="footer-item">
        <span>LUDs:&nbsp;</span>
        <For each={luds}>
          {lud => (
            <>
              <a
                href={`https://github.com/lnurl/luds/blob/luds/${lud}.md`}
                target="_blank"
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
