import {AiFillGithub} from 'solid-icons/ai'
import {IoLockClosedSharp} from 'solid-icons/io'
import {A} from '@solidjs/router'

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
    </footer>
  )
}
export default Footer
