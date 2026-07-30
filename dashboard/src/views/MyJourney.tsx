import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty, Panel } from "../components";
import { useSession } from "../session";
import type { Journey } from "../types";

/**
 * What a learner account sees. Reads /api/me/*, which resolves the learner id from
 * the session — no id in the URL, so there is nothing to edit to see someone else.
 */
export default function MyJourney() {
  const { user } = useSession();
  const [journey, setJourney] = useState<Journey | null>(null);
  const [checkin, setCheckin] = useState<{ message: string; status: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAgentDetails, setShowAgentDetails] = useState(false);

  useEffect(() => {
    api.myJourney()
      .then((j) => { setJourney(j); setErr(null); })
      .catch((e) => { setJourney(null); setErr(e instanceof Error ? e.message : String(e)); });
  }, []);

  const askCoach = async () => {
    setBusy(true); setErr(null);
    try { setCheckin(await api.myCheckin()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const first = user?.name?.split(" ")[0] ?? "there";
  const done = journey?.completed ?? 0;
  const total = journey?.total ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <>
      <h1>Hi {first}</h1>
      <div className="sub">Your journey to becoming an AI Implementation Executive.</div>

      {err && <div className="banner danger" onClick={() => setErr(null)}>⚠︎ {err} <span className="sub">(click to dismiss)</span></div>}

      {journey && !journey.enrolled && (
        <RoadmapAndAgents first={first} />
      )}

      {journey?.enrolled && (
        <>
          <Panel title={journey.course_title ?? "Your course"}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
              <b style={{ fontFamily: "var(--serif)", fontSize: 22 }}>{done} of {total} lessons</b>
              <span className="sub">{pct}% complete</span>
            </div>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>

            {journey.next_lesson ? (
              <div style={{ marginTop: 16 }}>
                <h3>Up next</h3>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="pill accent">{journey.next_lesson.type}</span>
                  <b>{journey.next_lesson.title}</b>
                </div>
                <div className="sub" style={{ marginTop: 4 }}>
                  In {journey.next_lesson.module} — we'll send this to you on WhatsApp.
                </div>
              </div>
            ) : (
              <div className="sub" style={{ marginTop: 14 }}>Nothing pending right now. Nice work.</div>
            )}
          </Panel>

          {journey.project && (
            <Panel title="Your solution">
              <div className="kv">
                <div className="k">Project</div><div>{journey.project.title}</div>
                <div className="k">Stakeholder</div><div>{journey.project.stakeholder}</div>
                <div className="k">Status</div><div><span className="pill">{journey.project.status}</span></div>
                {journey.project.success_metric && (<><div className="k">Success metric</div><div>{journey.project.success_metric}</div></>)}
              </div>
            </Panel>
          )}

          <Panel title="Your weeks">
            {(journey.modules ?? []).map((m, i) => (
              <div key={i} className="lesson-row">
                <span className={`pill ${m.complete ? "ok" : ""}`} style={{ minWidth: 58, justifyContent: "center" }}>
                  {m.done}/{m.total}
                </span>
                <span>{m.title}</span>
                {m.milestone && <span className="sub" style={{ marginLeft: "auto" }}>🎯 {m.milestone.title}</span>}
              </div>
            ))}
          </Panel>

          <div className="filters">
            <button className="chip on" disabled={busy} onClick={askCoach}>
              {busy ? "Asking…" : "Ask my coach where I stand"}
            </button>
          </div>
          {checkin && (
            <Panel title="From your coach">
              <div style={{ whiteSpace: "pre-wrap" }}>{checkin.message}</div>
            </Panel>
          )}

          <div style={{ marginTop: 32, display: "flex", justifyContent: "center" }}>
            <button className="chip" onClick={() => setShowAgentDetails(!showAgentDetails)}>
              {showAgentDetails ? "Hide AI Support Team & Roadmap" : "Show AI Support Team & Roadmap"}
            </button>
          </div>

          {showAgentDetails && (
            <div style={{ marginTop: 24, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
              <RoadmapAndAgents first={first} />
            </div>
          )}
        </>
      )}
    </>
  );
}

function RoadmapAndAgents({ first }: { first: string }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div className="onboarding-welcome">
        <h2>Welcome to your Destiny, {first}!</h2>
        <p>
          You have successfully completed your initial registration. You are now ready to begin your journey to becoming an AI Implementation Executive. Here is what to expect and how your AI support team will guide you.
        </p>
      </div>

      <div className="whatsapp-action-card">
        <div className="whatsapp-icon">💬</div>
        <div className="whatsapp-action-text">
          <h3>Next Step: Activate WhatsApp</h3>
          <p>
            WhatsApp is your primary classroom. Open WhatsApp and send the message <strong>START</strong> to the chat where you received your verification code. This will activate your daily training!
          </p>
        </div>
      </div>

      <h2>Your Student Journey</h2>
      <div className="roadmap-grid">
        <div className="roadmap-card">
          <div className="step-num">1</div>
          <h3>Intake & Setup</h3>
          <p>Verify your details and submit your documents (KYC + CV) on WhatsApp to set up your learner profile.</p>
        </div>
        <div className="roadmap-card">
          <div className="step-num">2</div>
          <h3>Personalized Lessons</h3>
          <p>Receive daily personalized micro-lessons and quizzes on WhatsApp, specifically tailored to your performance.</p>
        </div>
        <div className="roadmap-card">
          <div className="step-num">3</div>
          <h3>Real-World Project</h3>
          <p>Define a real business project and implement AI tools to solve concrete operational challenges.</p>
        </div>
        <div className="roadmap-card">
          <div className="step-num">4</div>
          <h3>Placement & Hiring</h3>
          <p>Build a portfolio of actual deployments, finish the curriculum, and get placed full-time in a growing business.</p>
        </div>
      </div>

      <h2>Meet Your AI Agent Team</h2>
      <div className="sub" style={{ marginBottom: 16 }}>These specialized agents will guide, teach, and assess you on WhatsApp 24/7.</div>

      <div className="agents-grid">
        <div className="agent-card">
          <div className="agent-avatar onboarding">📱</div>
          <div className="agent-info">
            <h3>Onboarding Agent</h3>
            <span className="role-tag">First Contact & Document Intake</span>
            <p>Verifies your number, welcomes you to D2D, and collects your CV and documents to start your profile.</p>
          </div>
        </div>

        <div className="agent-card">
          <div className="agent-avatar trainer">🎓</div>
          <div className="agent-info">
            <h3>Personal Trainer</h3>
            <span className="role-tag">Daily Lesson Delivery</span>
            <p>Serves your daily lesson briefs, quizzes, and tasks. Adjusts the curriculum speed based on your strengths.</p>
          </div>
        </div>

        <div className="agent-card">
          <div className="agent-avatar mentor">💬</div>
          <div className="agent-info">
            <h3>Mentor Agent</h3>
            <span className="role-tag">24/7 Doubts & Support</span>
            <p>Always active to answer any questions or explain business and tech concepts in simple terms.</p>
          </div>
        </div>

        <div className="agent-card">
          <div className="agent-avatar examiner">📝</div>
          <div className="agent-info">
            <h3>Examiner Agent</h3>
            <span className="role-tag">Scoring & Quizzes</span>
            <p>Grades your assessments and scores lesson milestones to certify that you have mastered each topic.</p>
          </div>
        </div>

        <div className="agent-card">
          <div className="agent-avatar assessor">🔍</div>
          <div className="agent-info">
            <h3>Assessor Agent</h3>
            <span className="role-tag">Project Grading</span>
            <p>Generates hyper-personalized tasks based on your live project and scores your operational solutions.</p>
          </div>
        </div>

        <div className="agent-card">
          <div className="agent-avatar motivator">⚡</div>
          <div className="agent-info">
            <h3>Motivator Agent</h3>
            <span className="role-tag">Progress Nudges</span>
            <p>Checks in to encourage you, send friendly reminders, and support you if your progress stalls.</p>
          </div>
        </div>

        <div className="agent-card" style={{ gridColumn: "1 / -1" }}>
          <div className="agent-avatar coach">🤝</div>
          <div className="agent-info">
            <h3>Coach Agent</h3>
            <span className="role-tag">AI Program Manager</span>
            <p>Conducts weekly check-ins to evaluate if you are on-track, helps unblock problems, and escalates to human facilitators when needed.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
