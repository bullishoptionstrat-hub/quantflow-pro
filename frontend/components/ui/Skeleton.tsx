'use client'

export function Skeleton({ className = '', style = {} }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={{ height: 16, borderRadius: 4, ...style }} />
}

export function TableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
          {Array.from({ length: 10 }).map((_, j) => (
            <td key={j} style={{ padding: '9px 10px' }}>
              <Skeleton style={{ width: `${50 + Math.random() * 40}%`, height: 13 }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}

export function CardSkeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton card" style={{ height }} />
}
