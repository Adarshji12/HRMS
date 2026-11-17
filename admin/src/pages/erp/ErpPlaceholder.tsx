export default function ErpPlaceholder({ title }: { title: string }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p>This screen is not built yet. It has a place in the menu so the structure is in, but there is nothing behind it.</p>
        </div>
      </div>
    </div>
  )
}
