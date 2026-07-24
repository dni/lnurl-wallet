import toast from 'solid-toast'

export enum NotifyKind {
  SUCCESS = 'success',
  ERROR = 'error',
  LOADING = 'loading'
}

export const notify = (
  message: string,
  _type: NotifyKind | null = null
): void => {
  switch (_type) {
    case NotifyKind.SUCCESS:
      toast.success(message)
      break
    case NotifyKind.ERROR:
      toast.error(message)
      break
    case NotifyKind.LOADING:
      toast.loading(message)
      break
    default:
      toast(message)
  }
}

export const copyToClipboard = (text: string): void => {
  try {
    navigator.clipboard.writeText(text)
    notify('Copied to clipboard!', NotifyKind.SUCCESS)
  } catch (err) {
    notify('Failed to copy to clipboard.', NotifyKind.ERROR)
  }
}

export const pasteFromClipboard = async (): Promise<string | null> => {
  try {
    return await navigator.clipboard.readText()
  } catch (err) {
    notify('Failed to paste from clipboard.', NotifyKind.ERROR)
    return null
  }
}

export const msatToSats = (msat: number): string =>
  (msat / 1000).toLocaleString()

export const satsToMsat = (sats: string | number): number =>
  Math.round(Number(sats) * 1000)

export const formatDate = (ts: number): string =>
  new Date(ts).toLocaleString()
