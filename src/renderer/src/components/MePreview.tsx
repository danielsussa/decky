const DEFAULT_URL = 'http://127.0.0.1:6789'

interface MePreviewProps {
  url?: string
}

export default function MePreview({ url }: MePreviewProps): React.JSX.Element {
  return (
    <iframe className="liveview-frame" src={url ?? DEFAULT_URL} title="me live view" />
  )
}
