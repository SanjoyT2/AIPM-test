/**
 * Seeds the REAL curriculum from FDE_Campus_Curriculum_D2D.docx:
 *   Track 2 — Forward Deployed Engineer (FDE), the 8-week technical program built
 *   around ONE business solution the student completes. Each week = a module with a
 *   human-spine thread, technical lessons (briefs the Trainer personalizes), and a
 *   hard milestone. Also seeds Track 1 (AIE Foundations) so the Coach has a catalog.
 * Idempotent-ish: skips a course whose title already exists.
 */
const BASE = process.env.SEED_TARGET ?? "http://localhost:8000";
async function post(path: string, body: unknown) {
  const key = process.env.OPERATOR_KEY ?? "dev_operator_key";
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator-key": key },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

type L = { type: string; competency_id: string; title: string; objective: string; key_points: string[]; difficulty?: string; pass_mark?: number };
type M = { title: string; comps: string[]; human_spine: string; milestone: { title: string; definition_of_done: string }; lessons: L[] };

// Competencies reuse the existing framework ids where they fit (editable later).
const FDE: M[] = [
  { title: "Module 1 — Foundations & Core Logic", comps: ["L1.GENAI.PROMPTING", "L4.DOMAIN.DISCOVERY", "L2.CLAUDE.WORKFLOWS", "XC.COMMUNICATION"],
    human_spine: "Commit to one real business problem + a real stakeholder; run a discovery interview; validate direction with the stakeholder.",
    milestone: { title: "Repo live + core logic running", definition_of_done: "GitHub repo exists and v1 core logic is committed with clean history." },
    lessons: [
      { type: "micro", competency_id: "L4.DOMAIN.DISCOVERY", title: "Find one real problem", objective: "Teach choosing one real business problem with real data, a real daily user, and a measurable outcome.", key_points: ["real data exists", "a real daily user", "a measurable outcome", "someone other than the student signs off"], difficulty: "core" },
      { type: "task", competency_id: "XC.COMMUNICATION", title: "Write the problem in their words", objective: "Ask the learner to state their chosen stakeholder's problem in the stakeholder's OWN words, with one success metric.", key_points: ["stakeholder's language not jargon", "one measurable success metric", "who the daily user is"], difficulty: "core", pass_mark: 60 },
      { type: "micro", competency_id: "L1.GENAI.PROMPTING", title: "How LLMs actually work", objective: "Teach tokens, context, temperature, capabilities and failure modes at a practical level.", key_points: ["tokens + context window", "temperature", "known failure modes", "when not to trust it"], difficulty: "intro" },
      { type: "quiz", competency_id: "L1.GENAI.PROMPTING", title: "Prompt as engineering", objective: "Ask the learner to turn a vague ask into a structured system prompt with role, constraints and output format for their solution.", key_points: ["role + context", "constraints", "explicit output format"], difficulty: "core", pass_mark: 60 },
      { type: "micro", competency_id: "L1.GENAI.PROMPTING", title: "Advanced prompting", objective: "Teach role prompts, chaining, structured JSON output and an evaluation mindset.", key_points: ["chaining", "structured JSON output", "evaluate outputs, don't trust blindly"], difficulty: "core" },
      { type: "task", competency_id: "L2.CLAUDE.WORKFLOWS", title: "Build with Claude Code", objective: "Ask the learner to describe how they'd use Claude Code to scaffold and debug their solution while keeping understanding.", key_points: ["scaffold then review", "correct AI-generated code", "never lose the thread"], difficulty: "stretch", pass_mark: 60 },
    ] },
  { title: "Module 2 — Grounding & Evaluation", comps: ["L3.AUTO.N8N", "L4.DOMAIN.SOLUTION", "L4.DOMAIN.MEASUREMENT"],
    human_spine: "Refine the empathy map from what the data reveals; keep the solution pointed at the real user as quality improves.",
    milestone: { title: "RAG system live with accuracy eval harness", definition_of_done: "A test set + LLM-as-judge shows a measurable accuracy improvement over stakeholder's real documents." },
    lessons: [
      { type: "micro", competency_id: "L3.AUTO.N8N", title: "RAG, plainly", objective: "Teach embeddings, vector DBs, chunking, retrieval and re-ranking at a build level.", key_points: ["embeddings + vector DB", "chunking strategy", "retrieve then re-rank"], difficulty: "core" },
      { type: "task", competency_id: "L4.DOMAIN.SOLUTION", title: "Plan your RAG", objective: "Ask the learner to outline how they'd build RAG over their stakeholder's real documents.", key_points: ["which documents", "chunking choice", "how they'll test accuracy"], difficulty: "stretch", pass_mark: 60 },
      { type: "micro", competency_id: "L4.DOMAIN.MEASUREMENT", title: "Evaluate, don't vibe", objective: "Teach building a test set, LLM-as-judge, measuring faithfulness/accuracy, and adding guardrails.", key_points: ["build a test set", "LLM-as-judge", "measure faithfulness", "add guardrails"], difficulty: "core" },
      { type: "task", competency_id: "L4.DOMAIN.MEASUREMENT", title: "Debug a retrieval failure", objective: "Give the learner a plausible retrieval failure and ask how they'd diagnose and fix it — the real technical-screen task.", key_points: ["isolate retrieval vs generation", "inspect chunks", "fix + re-measure"], difficulty: "stretch", pass_mark: 60 },
    ] },
  { title: "Module 3 — Agents & Deployed Solutions", comps: ["L2.CLAUDE.WORKFLOWS", "L3.AUTO.N8N", "L3.AUTO.DELIVERY"],
    human_spine: "Re-map stakeholders as the solution's scope grows; keep cost + latency honest.",
    milestone: { title: "Multi-step agent running live in production", definition_of_done: "An agent completes a real multi-step task end to end, hosted at a live URL." },
    lessons: [
      { type: "micro", competency_id: "L2.CLAUDE.WORKFLOWS", title: "When an agent beats a prompt", objective: "Teach tool use / function calling, orchestration, and multi-step/multi-agent patterns (LangGraph, MCP).", key_points: ["tool use / function calling", "when an agent > a prompt", "multi-step orchestration"], difficulty: "core" },
      { type: "task", competency_id: "L3.AUTO.N8N", title: "Design your agent", objective: "Ask the learner to specify the multi-step task their solution's agent will complete, with its tools.", key_points: ["the multi-step task", "tools it calls", "where a human stays in the loop"], difficulty: "stretch", pass_mark: 60 },
      { type: "micro", competency_id: "L3.AUTO.DELIVERY", title: "Notebook to product", objective: "Teach FastAPI/Streamlit, env vars + secrets, cloud hosting, a live URL, light Docker, CI/CD intro, and cost/latency awareness.", key_points: ["FastAPI/Streamlit", "secrets + env", "cloud host + live URL", "watch cost + latency"], difficulty: "core" },
      { type: "task", competency_id: "L3.AUTO.DELIVERY", title: "Ship it", objective: "Ask the learner for their deployment plan: host, secrets handling, and how they'll monitor cost.", key_points: ["hosting choice", "secrets never in git", "monitor cost/latency"], difficulty: "stretch", pass_mark: 60 },
    ] },
  { title: "Module 4 — Adoption, Capstone & Handover", comps: ["XC.COMMUNICATION", "XC.OBJECTION", "L4.DOMAIN.SOLUTION", "XC.INTEGRITY"],
    human_spine: "Finalise the Stakeholder & Empathy Dossier; hand over the solution to the real stakeholder and defend it.",
    milestone: { title: "Project completed, handed over, and defended", definition_of_done: "The business solution is finished, handed over to the stakeholder, and defended in a capstone viva." },
    lessons: [
      { type: "micro", competency_id: "XC.COMMUNICATION", title: "The last mile is adoption", objective: "Teach demoing, defending trade-offs, saying no, managing expectations, and getting the tool actually used.", key_points: ["demo + defend trade-offs", "say no well", "adoption = behaviour change", "write handover materials"], difficulty: "core" },
      { type: "roleplay", competency_id: "XC.OBJECTION", title: "The stakeholder who won't adopt", objective: "Role-play: the stakeholder likes the demo but keeps using the old way. The learner must move them to actually adopt it, without over-promising.", key_points: ["surface the real blocker", "make adoption easy", "no fabricated claims", "agree a concrete first-use"], difficulty: "stretch", pass_mark: 60 },
      { type: "task", competency_id: "L4.DOMAIN.SOLUTION", title: "Handover pack", objective: "Ask the learner to outline their handover: what the stakeholder gets, how they'll run it, and the measured outcome.", key_points: ["what's delivered", "how the stakeholder runs it", "the before/after metric"], difficulty: "stretch", pass_mark: 65 },
      { type: "roleplay", competency_id: "XC.INTEGRITY", title: "Defend your solution", objective: "Role-play a capstone defence: probe the learner on why they built it this way and what they'd do differently. They must own their choices.", key_points: ["explain choices in own words", "honest about trade-offs", "handle novel follow-ups"], difficulty: "stretch", pass_mark: 65 },
    ] },
];

async function seedCourse(title: string, outcome: string, mods: M[]) {
  const key = process.env.OPERATOR_KEY ?? "dev_operator_key";
  const existing = (await (await fetch(`${BASE}/api/courses`, { headers: { "x-operator-key": key } })).json()) as { title: string }[];
  if (existing.some((c) => c.title === title)) { console.log(`"${title}" already seeded — skipping.`); return; }
  const course = await post("/api/courses", { title, outcome }) as { course_id: string };
  let order = 1;
  for (const m of mods) {
    const mod = await post(`/api/courses/${course.course_id}/modules`, { title: m.title, order: order++, competencies: m.comps, milestone: m.milestone, human_spine: m.human_spine }) as { module_id: string };
    let lo = 1;
    for (const l of m.lessons) await post(`/api/modules/${mod.module_id}/lessons`, { ...l, order: lo++, personalize: true });
  }
  await post(`/api/courses/${course.course_id}/publish`, {});
  console.log(`Seeded + published "${title}": ${mods.length} modules, ${mods.reduce((n, m) => n + m.lessons.length, 0)} lessons.`);
}

async function main() {
  await seedCourse("FDE — Forward Deployed Engineer (4 Modules)", "Complete, deploy and hand over one real AI business solution — production-ready from day one.", FDE);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
