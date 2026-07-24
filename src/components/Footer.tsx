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

const luds = Object.keys(LUD_TITLES)

const Footer = () => {
  return (
    <footer class="footer">
      <span>LNURLwallet v0.0.1</span>
      &nbsp;|&nbsp;
      <a href="https://github.com/dni/lnurl-wallet" target="_blank">
        <AiFillGithub />
        &nbsp;Github
      </a>
      &nbsp;|&nbsp;
      <A href="/docs">
        <IoLockClosedSharp />
        &nbsp;serverless&nbsp;·&nbsp;keys never leave your browser
      </A>
      &nbsp;|&nbsp;
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
    </footer>
  )
}
export default Footer
