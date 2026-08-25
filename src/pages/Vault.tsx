import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {IoBanSharp, IoPencilSharp, IoTrashSharp} from 'solid-icons/io'

import {useDevice} from '../DeviceContext'
import type {DeviceNote, DeviceStorageState} from '../device'
import {
  approvalInstruction,
  inputWarning,
  canShowQrHandoff,
  gatedCommandsUnavailable
} from '../deviceGuidance'
import {identityWarning} from '../devicePinning'
import {msatToSats, notify, NotifyKind} from '../helpers'

// get_info's `storage` (docs/PROTOCOL.md) - only 'ok' (or absent, meaning
// this build has no persistent storage to worry about) means note_count
// can be trusted. Anything else means the device couldn't fully read its
// own notes this boot, and note_count === 0 must not be read as "empty".
const storageWarning = (
  storage: DeviceStorageState | undefined
): string | null => {
  switch (storage) {
    case 'index_unreadable':
      return "This device's note index couldn't be read this boot - its notes are still on flash, but hidden until you reboot the device. Do not wipe it: that would destroy exactly what this state exists to protect."
    case 'full':
      return "This device is out of storage - it can't create or update notes until you free some room (spend or delete existing ones)."
    case 'version_unsupported':
      return "This device's storage was written by newer firmware than it's currently running - update its firmware to read it again."
    case 'unavailable':
      return "This device's storage could not be brought up at all - its note count and note list below may be wrong or empty."
    default:
      return null
  }
}

// Pairing + read-only visibility for an LNURLvault hardware device (see
// ../../lnurl-vault) - connect over USB or Bluetooth, see its firmware
// version and the notes it holds. Routing this wallet's own rotate/split/
// merge/melt through the device instead of generating secrets in-browser
// lives in deviceOrchestration.ts, driven from Mint.tsx/BearerCard.tsx/
// MintGroupCard.tsx/SendDialog.tsx/Melt.tsx - this page itself stays scoped
// to pairing and read-only visibility, not those flows.
const Vault: Component = () => {
  const {
    connectionState,
    info,
    notes,
    serialSupported,
    bleSupported,
    connectSerial,
    connectBle,
    connectHeartwood,
    disconnect,
    reconnecting,
    identity,
    trustCurrentIdentity,
    refresh,
    rename,
    deleteNote,
    pruneSpent
  } = useDevice()

  const [busy, setBusy] = createSignal(false)
  const [showOtherWays, setShowOtherWays] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [labelInput, setLabelInput] = createSignal('')

  const spentCount = () => notes().filter(n => n.state === 'spent').length

  // one press for the lot, against one per note through the trash icons.
  // A rotate leaves its parent behind as a spent record by design, so these
  // pile up fast on a vault in use
  const clearSpent = async () => {
    const removed = await pruneSpent()
    notify(
      `Cleared ${removed} spent note${removed === 1 ? '' : 's'} from the device.`,
      NotifyKind.SUCCESS
    )
  }

  const withBusy = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const startRename = (note: DeviceNote) => {
    setEditingId(note.id)
    setLabelInput(note.label)
  }

  const saveRename = (id: string) =>
    withBusy(async () => {
      await rename(id, labelInput().trim())
      setEditingId(null)
    })

  return (
    <div id="vault" class="page">
      <h2>LNURLvault</h2>
      {/* the pairing call to action has to go once a vault is paired -
          left standing next to "No notes on this device yet" it reads as
          "you still have not paired", on a page that just did */}
      <Show
        when={connectionState() === 'connected'}
        fallback={
          <p>
            Pair an LNURLvault hardware device over USB or Bluetooth. The device
            generates and holds note secrets itself - this page only reads its
            state, it never sees a plaintext secret unless you explicitly export
            one on the device (which requires a physical button press there).
          </p>
        }
      >
        <p>
          This vault generates and holds its note secrets itself. This page only
          reads its state, and never sees a plaintext secret unless you export
          one on the device, which requires a physical button press there.
        </p>
      </Show>
      <Show
        when={connectionState() === 'connected'}
        fallback={
          <figure class="setup-card">
            <Show
              when={serialSupported || bleSupported}
              fallback={
                <p class="warning">
                  This browser supports neither WebSerial nor Web Bluetooth -
                  try Chrome or Edge on desktop or Android.
                </p>
              }
            >
              <Show
                when={!reconnecting()}
                fallback={<p class="bearer-hint">Looking for your vault...</p>}
              >
                <div class="btns">
                  <button
                    disabled={connectionState() === 'connecting'}
                    onClick={() =>
                      withBusy(serialSupported ? connectSerial : connectBle)
                    }
                  >
                    {serialSupported
                      ? 'Connect vault over USB'
                      : 'Connect vault over Bluetooth'}
                  </button>
                </div>
                <Show when={!showOtherWays()}>
                  <div class="btns">
                    <button onClick={() => setShowOtherWays(true)}>
                      Other ways to connect
                    </button>
                  </div>
                </Show>
                <Show when={showOtherWays()}>
                  <div class="btns">
                    <Show when={serialSupported && bleSupported}>
                      <button
                        disabled={connectionState() === 'connecting'}
                        onClick={() => withBusy(connectBle)}
                      >
                        Over Bluetooth
                      </button>
                    </Show>
                    <Show when={serialSupported}>
                      <button
                        disabled={connectionState() === 'connecting'}
                        onClick={() => withBusy(connectHeartwood)}
                      >
                        A Heartwood signer
                      </button>
                    </Show>
                  </div>
                </Show>
              </Show>
            </Show>
          </figure>
        }
      >
        <figure class="setup-card">
          <figcaption>
            {info()
              ? `Vault firmware ${info()!.fw_version}${info()!.board ? ` (${info()!.board})` : ''}`
              : 'Connected'}
          </figcaption>
          <Show when={identity() && identityWarning(identity()!)}>
            {message => (
              <>
                <p class="warning">{message()}</p>
                <div class="btns">
                  <Show when={identity()?.kind === 'changed'}>
                    <button disabled={busy()} onClick={trustCurrentIdentity}>
                      Trust this vault from now on
                    </button>
                  </Show>
                  <button
                    disabled={busy()}
                    onClick={() => withBusy(disconnect)}
                  >
                    Disconnect
                  </button>
                </div>
              </>
            )}
          </Show>
          <Show when={info()}>
            {i => (
              <>
                <Show when={storageWarning(i().storage)}>
                  {message => <p class="warning">{message()}</p>}
                </Show>
                <Show when={inputWarning(i())}>
                  {message => <p class="warning">{message()}</p>}
                </Show>
                <p class="bearer-hint">
                  {i().note_count} note{i().note_count === 1 ? '' : 's'} on
                  device, {i().pending_count} pending.
                </p>
                <p class="bearer-hint">{approvalInstruction(i())}</p>
                <Show when={i().capabilities && !canShowQrHandoff(i())}>
                  <p class="bearer-hint">
                    This vault's screen is too small to show a note as a QR
                    code, so notes on it can't be handed over in person.
                  </p>
                </Show>
              </>
            )}
          </Show>
          <div class="btns">
            <button disabled={busy()} onClick={() => withBusy(refresh)}>
              Refresh
            </button>
            <Show when={spentCount() > 0 && !gatedCommandsUnavailable(info())}>
              <button disabled={busy()} onClick={() => withBusy(clearSpent)}>
                Clear {spentCount()} spent
              </button>
            </Show>
            <button disabled={busy()} onClick={() => withBusy(disconnect)}>
              Disconnect
            </button>
          </div>
        </figure>
        <Show
          when={notes().length > 0}
          fallback={
            <p>
              {storageWarning(info()?.storage)
                ? "Can't reliably read this device's notes right now - see the warning above."
                : 'No notes on this device yet.'}
            </p>
          }
        >
          <div class="bearer-list">
            <For each={notes()}>
              {note => (
                <figure class="bearer-card">
                  <div class="bearer-head">
                    <div class="bearer-title">
                      <span class="bearer-amount">
                        {msatToSats(note.amount_msat)} sats
                      </span>
                      <Show when={note.label}>
                        <span class="bearer-label">{note.label}</span>
                      </Show>
                      <Show when={note.state === 'pending'}>
                        <span class="bearer-pending">pending</span>
                      </Show>
                      <Show when={note.state === 'spent'}>
                        <span class="bearer-spent">
                          <IoBanSharp />
                          &nbsp;spent
                        </span>
                      </Show>
                      <span class="bearer-server">{note.host}</span>
                    </div>
                  </div>
                  <Show
                    when={editingId() === note.id}
                    fallback={
                      <div class="btns">
                        <button
                          class="icon-btn"
                          title="Rename"
                          onClick={() => startRename(note)}
                        >
                          <IoPencilSharp />
                        </button>
                        <Show when={note.state === 'spent'}>
                          <button
                            class="icon-btn"
                            title="Delete from device"
                            disabled={busy()}
                            onClick={() => withBusy(() => deleteNote(note.id))}
                          >
                            <IoTrashSharp />
                          </button>
                        </Show>
                      </div>
                    }
                  >
                    <div class="form-item">
                      <input
                        type="text"
                        placeholder="label"
                        value={labelInput()}
                        onInput={e => setLabelInput(e.currentTarget.value)}
                        onKeyDown={e =>
                          e.key === 'Enter' && saveRename(note.id)
                        }
                      />
                      <div class="btns">
                        <button
                          disabled={busy()}
                          onClick={() => saveRename(note.id)}
                        >
                          Save
                        </button>
                        <button onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </Show>
                </figure>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
export default Vault
