import { Link } from 'react-router-dom'
import { IconCheck, IconInfo, IconUsers } from '../../components/Icons'
import '../../styles/joiners.css'

const STEPS = [
  ['1', 'Offer & Letter', 'Generate & send joining letters'],
  ['2', 'Document Check', 'Collect ID, tax & bank details'],
  ['3', 'Day-1 Ready', 'Confirm start date & handoff'],
]

const POINTS = [
  ['Single source of truth for new hires', 'Details entered during letter creation automatically carry forward into the joiner’s onboarding record.'],
  ['Clear pre-joining visibility', 'See at a glance who has signed their letter, uploaded documents, or still needs follow-up before Day 1.'],
  ['Seamless employee handoff', 'Once onboarding is completed, the joiner transitions smoothly into your active employee directory.'],
]

export default function JoinersLettersHub() {
  return (
    <div className="page">
      <div className="jl-head">
        <h1>Joiners &amp; Letters <span className="jl-pill">People Operations</span></h1>
        <p className="jl-sub">Manage new-hire onboarding, pre-joining checklists, and employment letters from one central hub.</p>
      </div>
      <div className="jl-grid">
        <section className="jl-card">
          <div className="jl-top">
            <div className="jl-id">
              <span className="jl-icon"><IconUsers size={22} /></span>
              <div><h2>Onboarding</h2><span className="jl-active">Active workspace</span></div>
            </div>
            <span className="jl-ready">Ready</span>
          </div>
          <p className="jl-desc">Track incoming joiners, verify required documents, and issue offer or appointment letters before their first day.</p>
          <div className="jl-incl">Included in this workspace</div>
          <div className="jl-steps">
            {STEPS.map(([n, title, text]) => (
              <div className="jl-step" key={n}><b><span className="jl-step-no">{n}</span>{title}</b><span>{text}</span></div>
            ))}
          </div>
          <div className="jl-foot">
            <Link className="btn btn-primary" to="/my-onboarding">Open onboarding →</Link>
            <small>Opens the full joiner tracker</small>
          </div>
        </section>

        <section className="jl-card jl-how">
          <h2><span className="jl-how-icon"><IconInfo size={16} /></span>How Joiners &amp; Letters works</h2>
          <p className="jl-desc">This section brings candidate offer letters and employee onboarding together so HR teams never have to duplicate new-hire details across separate tools.</p>
          <ul className="jl-points">
            {POINTS.map(([title, text]) => (
              <li key={title}><span className="jl-tick"><IconCheck size={13} /></span><div><b>{title}</b><span>{text}</span></div></li>
            ))}
          </ul>
          <div className="jl-note">Looking to review or add a new joiner? Use <b>Open onboarding</b> on the left to begin.</div>
        </section>
      </div>
    </div>
  )
}

