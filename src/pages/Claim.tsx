import type {Component} from 'solid-js'
import {Show, createMemo} from 'solid-js'
import {useNavigate, useSearchParams} from '@solidjs/router'

import RequireWallet from '../components/RequireWallet'
import ReceiveDialog from '../components/ReceiveDialog'
import {claimLinkToNoteInput} from '../claimLink'

// Where a vault's handoff QR lands (lnurl-vault src/proto/note_url.c). The
// point of the format is that a stranger's phone camera opens it at all,
// which lnurlw:// never did (issue #26).
//
// It deliberately does NOT accept the note by itself. The link is money and
// it arrived from someone else, so it opens the same receive dialog a paste
// or a scan would, prefilled - the person sees what they are taking and from
// which mint before anything is fetched or stored.
const Claim: Component = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const note = createMemo(() => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(searchParams)) {
      if (typeof value === 'string') params.set(key, value)
    }
    return claimLinkToNoteInput(params)
  })

  return (
    <RequireWallet>
      <div id="claim" class="page">
        <h2>Claim a note</h2>
        <Show
          when={note()}
          fallback={
            <p class="warning">
              This link isn’t a bearer note. Check it was scanned whole - the
              code carries a mint and a secret, and a partial scan drops one.
            </p>
          }
        >
          {value => (
            <ReceiveDialog
              initialValue={value()}
              onClose={() => navigate('/wallet')}
            />
          )}
        </Show>
      </div>
    </RequireWallet>
  )
}

export default Claim
