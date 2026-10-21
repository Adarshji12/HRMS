export default function ErpPlaceholder({ title }: { title: string }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p>This is a frontend placeholder. ERP backend functionality is not implemented.</p>
        </div>
      </div>
    </div>
  )
}
