import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {IoBanSharp, IoPencilSharp, IoTrashSharp} from 'solid-icons/io'

import {useDevice} from '../DeviceContext'
import type {DeviceNote} from '../device'
import {msatToSats, notify, NotifyKind} from '../helpers'

// Pairing + read-only visibility for an LNURLvault hardware device (see
// ../../lnurl-vault) - connect over USB or Bluetooth, see its firmware
// version and the notes it holds. What's NOT here yet: routing this
// wallet's own rotate/split/merge/melt through the device instead of
// generating secrets in-browser - see device.ts's header comment for why
// that's a deliberate later step, not part of this page.
const Vault: Component = () => {
  const {
    connectionState,
    info,
    notes,
    serialSupported,
    bleSupported,
    connectSerial,
    connectBle,
    disconnect,
    refresh,
    rename,
    deleteNote
  } = useDevice()

  const [busy, setBusy] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [labelInput, setLabelInput] = createSignal('')

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
      <p>
        Pair an LNURLvault hardware device over USB or Bluetooth. The device
        generates and holds note secrets itself - this page only reads its
        state, it never sees a plaintext secret unless you explicitly export one
        on the device (which requires a physical button press there).
      </p>
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
              <div class="btns">
                <Show when={serialSupported}>
                  <button
                    disabled={connectionState() === 'connecting'}
                    onClick={() => withBusy(connectSerial)}
                  >
                    Connect via USB
                  </button>
                </Show>
                <Show when={bleSupported}>
                  <button
                    disabled={connectionState() === 'connecting'}
                    onClick={() => withBusy(connectBle)}
                  >
                    Connect via Bluetooth
                  </button>
                </Show>
              </div>
            </Show>
          </figure>
        }
      >
        <figure class="setup-card">
          <figcaption>
            {info() ? `Vault firmware ${info()!.fw_version}` : 'Connected'}
          </figcaption>
          <Show when={info()}>
            {i => (
              <p class="bearer-hint">
                {i().note_count} note{i().note_count === 1 ? '' : 's'} on
                device, {i().pending_count} pending.
              </p>
            )}
          </Show>
          <div class="btns">
            <button disabled={busy()} onClick={() => withBusy(refresh)}>
              Refresh
            </button>
            <button disabled={busy()} onClick={() => withBusy(disconnect)}>
              Disconnect
            </button>
          </div>
        </figure>
        <Show
          when={notes().length > 0}
          fallback={<p>No notes on this device yet.</p>}
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
