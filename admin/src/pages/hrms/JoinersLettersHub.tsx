import { Link } from 'react-router-dom'

export default function JoinersLettersHub() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Joiners &amp; Letters</h1>
          <p>This is a navigation placeholder. Open an existing workspace below.</p>
        </div>
      </div>
      <div className="grid grid-2">
        <section className="card">
          <h2 className="card-title">Onboarding</h2>
          <p className="page-sub">Review the existing onboarding workspace.</p>
          <Link className="btn btn-primary" to="/my-onboarding">Open onboarding</Link>
        </section>
      </div>
    </div>
  )
}
