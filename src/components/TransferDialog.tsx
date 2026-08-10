import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo, onCleanup} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {IoRefreshSharp} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import type {PayRequestInfo} from '../lnurlcash'
import {
  resolveMintInput,
  fetchPayRequest,
  requestInvoice,
  fetchInvoiceVerification,
  buildNoteUrl,
  withNewK1,
  fetchNoteInfo,
  rotateNote,
  meltNote,
  noteK1,
  serverOf,
  isPreimage,
  applyMintFee,
  describeMintFee,
  PendingNoteError
} from '../lnurlcash'
import {notify, NotifyKind, msatToSats, copyToClipboard} from '../helpers'
import {isMintTrusted, addTrustedMint, trustedMints} from '../trustedMints'
import {offlineMode} from '../offlineMode'
import Qr from './Qr'

export type TransferDialogProps = {
  sourceBearer: Bearer
  onClose: () => void
}

// same cadence as Mint.tsx's LUD-21 verify poll and Melt.tsx's pending-melt
// poll - this is really both of those chained together
const TRANSFER_POLL_SECONDS = 10

// moves a note's value to a different mint - there's no such primitive in
// the protocol itself, only melt (burn + pay an invoice) and minting (pay a
// payRequest, the preimage becomes a fresh k1). So a "transfer" here is:
// request an invoice from the destination for exactly this note's value,
// melt the source note to pay it (this wallet IS the payer, funded by the
// note instead of an external wallet), then claim the destination note once
// its invoice settles - via the destination's own LUD-21 verify if it has
// one, same as Mint.tsx's own payment flow, since we're in exactly the
// position that convenience is meant for (the legitimate payer checking on
// its own payment, not a third party snooping the verify endpoint)
const TransferDialog: Component<TransferDialogProps> = props => {
  const {addBearer, updateBearer} = useWallet()
  const navigate = useNavigate()

  const [mintInput, setMintInput] = createSignal('')
  const [payRequest, setPayRequest] = createSignal<PayRequestInfo | null>(null)
  const [pendingTrust, setPendingTrust] = createSignal<{
    server: string
    mintPubkey: string
    info: PayRequestInfo
  } | null>(null)
  const [busy, setBusy] = createSignal(false)

  const [invoice, setInvoice] = createSignal<string | null>(null)
  const [verifyUrl, setVerifyUrl] = createSignal<string | null>(null)
  const [preimage, setPreimage] = createSignal('')
  const [claimed, setClaimed] = createSignal(false)
  const [sourceConfirmed, setSourceConfirmed] = createSignal(false)

  const [secondsLeft, setSecondsLeft] = createSignal(TRANSFER_POLL_SECONDS)
  const [checking, setChecking] = createSignal(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  const sourceK1 = () => noteK1(props.sourceBearer.url)!

  const lookup = async () => {
    const url = resolveMintInput(mintInput())
    if (!url) {
      notify('Enter a mint LNURL or Lightning Address.', NotifyKind.ERROR)
      return
    }
    setPendingTrust(null)
    setBusy(true)
    try {
      const info = await fetchPayRequest(url)
      if (!info.withdrawLink) {
        notify(
          'This payRequest does not advertise lnurlcash minting (no withdrawLink).',
          NotifyKind.ERROR
        )
        return
      }
      const server = serverOf(url)
      if (server === serverOf(props.sourceBearer.url)) {
        notify("That's the mint this note is already on.", NotifyKind.ERROR)
        return
      }
      if (
        props.sourceBearer.amount < info.minSendable ||
        props.sourceBearer.amount > info.maxSendable
      ) {
        notify(
          `${server} only accepts ${msatToSats(info.minSendable)}-${msatToSats(info.maxSendable)} sats - this note is ${msatToSats(props.sourceBearer.amount)}.`,
          NotifyKind.ERROR
        )
        return
      }
      if (info.mintPubkey && !isMintTrusted(server)) {
        setPendingTrust({server, mintPubkey: info.mintPubkey, info})
        return
      }
      setPayRequest(info)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const selectMint = (address: string) => {
    setMintInput(address)
    lookup()
  }

  const confirmTrust = () => {
    const pending = pendingTrust()
    if (!pending) return
    addTrustedMint(pending.server, pending.mintPubkey)
    setPendingTrust(null)
    setPayRequest(pending.info)
  }

  const cancelTrust = () => {
    setPendingTrust(null)
    notify('Mint not trusted - lookup cancelled.', NotifyKind.ERROR)
  }

  // `payRequest() && !pendingTrust()` would return the boolean from the
  // `&&`, not the PayRequestInfo - this narrows properly so the Show below
  // can hand its children the actual object
  const readyPayRequest = createMemo(() =>
    !pendingTrust() ? payRequest() : null
  )

  // meltNote pays `pr` of exactly the note's value, so unlike Mint.tsx
  // there's no invoice amount to gross up here - the destination is always
  // invoiced for the full source amount. What its mint fee (if any) does
  // instead is shrink the note that comes out the other end, which this
  // estimates so the payer isn't surprised (the authoritative value is
  // whatever the destination's informational GET reports once claimed)
  const expectedNet = createMemo(() => {
    const info = payRequest()
    return info?.mintFee
      ? applyMintFee(props.sourceBearer.amount, info.mintFee)
      : props.sourceBearer.amount
  })

  // fires the transfer: get an invoice for exactly the note's value, then
  // melt the note to pay it - the source is locked as spent immediately,
  // same as any other melt, and confirmed (or restored) by polling below
  const startTransfer = async () => {
    const info = payRequest()
    if (!info?.withdrawLink) return
    setBusy(true)
    try {
      const result = await requestInvoice(
        info.callback,
        props.sourceBearer.amount
      )
      await meltNote(props.sourceBearer.callback, sourceK1(), result.pr)
      await updateBearer(props.sourceBearer.id, {spent: true})
      setInvoice(result.pr)
      if (result.verify) setVerifyUrl(result.verify)
      notify(
        'Melting the note to fund the transfer - confirming...',
        NotifyKind.LOADING
      )
      startPolling()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // claims the destination note once its preimage is known - same claim
  // sequence as Mint.tsx: verify (also settling the k1), rotate to close
  // the exposure that GET just created, then store it
  const claimDestination = async (preimageValue: string) => {
    const info = payRequest()
    if (!info?.withdrawLink || !isPreimage(preimageValue)) return
    try {
      const declaredUrl = buildNoteUrl(
        info.withdrawLink,
        preimageValue,
        props.sourceBearer.amount
      )
      const noteInfo = await fetchNoteInfo(declaredUrl)
      const mintPubkey = noteInfo.mintPubkey
      let url = withNewK1(declaredUrl, noteInfo.k1, noteInfo.maxWithdrawable)
      try {
        const rotated = await rotateNote(noteInfo.callback, noteInfo.k1)
        url = withNewK1(
          declaredUrl,
          rotated.k1,
          noteInfo.maxWithdrawable,
          rotated.signature
        )
      } catch {
        notify(
          'Destination does not support rotation - the preimage was just transmitted, treat this note as exposed.',
          NotifyKind.ERROR
        )
      }
      await addBearer({
        url,
        callback: noteInfo.callback,
        amount: noteInfo.maxWithdrawable,
        verified: true,
        mintPubkey
      })
      setClaimed(true)
      stopPolling()
      notify(
        `Transferred ${msatToSats(noteInfo.maxWithdrawable)} sats to ${serverOf(url)}.`,
        NotifyKind.SUCCESS
      )
      navigate('/wallet')
      props.onClose()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  // one tick checks both sides: whether the destination invoice settled
  // (learning the preimage, then claiming) and - independently - whether
  // the source note actually burned. Rotating it succeeding means it was
  // still there (the transfer failed, restore it); any other failure means
  // it's gone, which just leaves the destination claim (auto or manual) as
  // the remaining step
  const checkTransfer = async () => {
    if (checking()) return
    setChecking(true)
    try {
      if (!claimed()) {
        const url = verifyUrl()
        if (url) {
          try {
            const result = await fetchInvoiceVerification(url)
            if (
              result.settled &&
              result.preimage &&
              isPreimage(result.preimage)
            ) {
              setPreimage(result.preimage)
              await claimDestination(result.preimage)
            }
          } catch {
            // a single failed check isn't fatal - the next tick tries again
          }
        }
      }
      if (!claimed() && !sourceConfirmed()) {
        try {
          const rotated = await rotateNote(
            props.sourceBearer.callback,
            sourceK1()
          )
          stopPolling()
          await updateBearer(props.sourceBearer.id, {
            url: withNewK1(
              props.sourceBearer.url,
              rotated.k1,
              props.sourceBearer.amount,
              rotated.signature
            ),
            spent: false
          })
          notify(
            'Transfer failed - the note is still yours (freshly rotated). You can try again.',
            NotifyKind.ERROR
          )
          props.onClose()
          return
        } catch (err) {
          if (!(err instanceof PendingNoteError)) setSourceConfirmed(true)
        }
      }
    } finally {
      setChecking(false)
    }
  }

  const startPolling = () => {
    stopPolling()
    setSecondsLeft(TRANSFER_POLL_SECONDS)
    pollTimer = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          checkTransfer()
          return TRANSFER_POLL_SECONDS
        }
        return s - 1
      })
    }, 1000)
  }

  const manualCheck = () => {
    checkTransfer()
    startPolling()
  }

  onCleanup(stopPolling)

  return (
    <figure class="setup-card">
      <figcaption>
        Transfer {msatToSats(props.sourceBearer.amount)} sats to another mint
      </figcaption>
      <Show when={!invoice()}>
        <label>Destination mint (LNURL or Lightning Address)</label>
        <input
          type="text"
          placeholder="lnurl1... or mint@example.com"
          value={mintInput()}
          onInput={e => setMintInput(e.currentTarget.value)}
          onKeyDown={e => e.key === 'Enter' && lookup()}
        />
        <div class="btns">
          <button disabled={busy() || offlineMode()} onClick={lookup}>
            <Show when={busy()}>
              <IoRefreshSharp class="spin" />
              &nbsp;
            </Show>
            Look up mint
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </div>
        <Show when={trustedMints().length > 0}>
          <div class="mint-picker">
            <For each={trustedMints()}>
              {mint => (
                <button
                  disabled={busy() || offlineMode()}
                  onClick={() => selectMint(`mint@${mint.server}`)}
                >
                  {mint.server}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={pendingTrust()}>
          {pending => (
            <>
              <p>
                First time seeing a signing key from{' '}
                <strong>{pending().server}</strong>. Trusting it lets its notes
                show as offline-verified against this key.
              </p>
              <pre>{pending().mintPubkey}</pre>
              <div class="btns">
                <button onClick={confirmTrust}>Trust this mint</button>
                <button onClick={cancelTrust}>Cancel</button>
              </div>
            </>
          )}
        </Show>
        <Show when={readyPayRequest()}>
          {info => (
            <>
              <Show when={info().mintFee}>
                {fee => (
                  <p class="warning">
                    {serverOf(info().callback)} withholds a fee on minting:{' '}
                    {describeMintFee(fee())}. The note you end up holding there
                    will be worth less than the one you're melting.
                  </p>
                )}
              </Show>
              <p class="bearer-hint">
                Transfer exactly {msatToSats(props.sourceBearer.amount)} sats to{' '}
                {serverOf(info().callback)}? The source note is melted to fund
                it - this can't be undone.
                <Show when={info().mintFee}>
                  {' '}
                  You'll end up with ~{msatToSats(expectedNet())} sats there.
                </Show>
              </p>
              <div class="btns">
                <button
                  disabled={busy() || offlineMode()}
                  onClick={startTransfer}
                >
                  <Show when={busy()}>
                    <IoRefreshSharp class="spin" />
                    &nbsp;
                  </Show>
                  Confirm transfer
                </button>
              </div>
            </>
          )}
        </Show>
      </Show>
      <Show when={invoice()}>
        <p class="bearer-hint">
          Melting the source note to fund this invoice at the destination mint -
          it's locked as spent until this confirms.
        </p>
        <Qr value={invoice()!.toUpperCase()} />
        <div class="btns">
          <button onClick={() => copyToClipboard(invoice()!)}>
            Copy invoice
          </button>
          <button disabled={checking() || offlineMode()} onClick={manualCheck}>
            <Show when={checking()}>
              <IoRefreshSharp class="spin" />
              &nbsp;
            </Show>
            {checking() ? 'Checking...' : `Check transfer (${secondsLeft()}s)`}
          </button>
        </div>
        <Show when={!verifyUrl()}>
          <label>
            This mint doesn't support checking automatically - paste the
            preimage here if you learn it some other way
          </label>
          <input
            type="text"
            placeholder="payment preimage (64 hex characters)"
            value={preimage()}
            onInput={e => setPreimage(e.currentTarget.value)}
          />
          <div class="btns">
            <button
              disabled={!isPreimage(preimage()) || offlineMode()}
              onClick={() => claimDestination(preimage())}
            >
              Claim at destination
            </button>
          </div>
        </Show>
      </Show>
    </figure>
  )
}
export default TransferDialog
