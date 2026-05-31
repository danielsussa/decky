type Props = {
  additions: number
  deletions: number
}

const SQUARES = 5

function bucketize(additions: number, deletions: number): { green: number; red: number; empty: number } {
  const total = additions + deletions
  if (total === 0) return { green: 0, red: 0, empty: SQUARES }
  let green = Math.round((additions / total) * SQUARES)
  let red = Math.round((deletions / total) * SQUARES)
  if (additions > 0 && green === 0) green = 1
  if (deletions > 0 && red === 0) red = 1
  while (green + red > SQUARES) {
    if (green >= red) green--
    else red--
  }
  return { green, red, empty: SQUARES - green - red }
}

export default function GitStats({ additions, deletions }: Props): React.JSX.Element | null {
  if (additions === 0 && deletions === 0) return null
  const { green, red, empty } = bucketize(additions, deletions)
  const squares: Array<'g' | 'r' | 'e'> = [
    ...Array(green).fill('g'),
    ...Array(red).fill('r'),
    ...Array(empty).fill('e')
  ]
  return (
    <span className="git-stats" title={`+${additions} −${deletions} (não commitado)`}>
      <span className="git-stats-add">+{additions}</span>
      <span className="git-stats-del">−{deletions}</span>
      <span className="git-stats-bar" aria-hidden="true">
        {squares.map((s, i) => (
          <span key={i} className={`git-stats-sq git-stats-sq-${s}`} />
        ))}
      </span>
    </span>
  )
}
