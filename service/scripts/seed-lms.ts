/**
 * Seeds the flagship course so the LMS isn't empty: "AIE Foundations" — 4 modules
 * (L1-L4), lessons as briefs (the Trainer renders them per learner). Idempotent-ish:
 * skips if a course with the same title already exists.
 */
const BASE = process.env.SEED_TARGET ?? "http://localhost:8000";

async function post(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

const MODULES = [
  { title: "GenAI Foundations", comps: ["L1.GENAI.PROMPTING", "L1.GENAI.MODEL_JUDGMENT"], lessons: [
    { type: "micro", competency_id: "L1.GENAI.PROMPTING", title: "What a good prompt is", objective: "Teach that a good prompt gives role, context, constraints and desired format.", key_points: ["role + context", "constraints", "output format", "iterate on bad output"], difficulty: "intro" },
    { type: "quiz", competency_id: "L1.GENAI.PROMPTING", title: "Spot the better prompt", objective: "Ask the learner to improve a one-line prompt for a saree shop's WhatsApp caption, and explain why their version is better.", key_points: ["adds context", "specifies format", "audience-aware"], difficulty: "core", pass_mark: 60 },
    { type: "micro", competency_id: "L1.GENAI.MODEL_JUDGMENT", title: "When to trust the model", objective: "Teach hallucination awareness and verifying before using output with a client.", key_points: ["models can be confidently wrong", "verify facts", "flag uncertainty"], difficulty: "core" },
  ] },
  { title: "Claude & the Toolbelt", comps: ["L2.CLAUDE.WORKFLOWS"], lessons: [
    { type: "micro", competency_id: "L2.CLAUDE.WORKFLOWS", title: "From chat to workflow", objective: "Teach composing an AI into a repeatable multi-step task for a business.", key_points: ["break the task into steps", "reuse the same recipe", "hand-off ready"], difficulty: "core" },
    { type: "task", competency_id: "L2.CLAUDE.WORKFLOWS", title: "Draft a reply-to-review workflow", objective: "Ask the learner to outline a 3-step workflow for a shop to respond to Google reviews using AI.", key_points: ["classify sentiment", "draft reply in owner's voice", "owner approves before send"], difficulty: "stretch", pass_mark: 60 },
  ] },
  { title: "Automation & Delivery", comps: ["L3.AUTO.N8N", "L3.AUTO.WHATSAPP"], lessons: [
    { type: "micro", competency_id: "L3.AUTO.WHATSAPP", title: "A WhatsApp catalog that sells", objective: "Teach setting up a WhatsApp Business catalog an owner can actually use.", key_points: ["clear photos", "price + fabric/occasion", "fast to update"], difficulty: "core" },
    { type: "task", competency_id: "L3.AUTO.N8N", title: "Sketch an automation", objective: "Ask the learner to describe a simple n8n automation that answers a shop's FAQ on WhatsApp.", key_points: ["trigger on message", "match FAQ", "fallback to human"], difficulty: "stretch", pass_mark: 60 },
  ] },
  { title: "Domain & the Client Conversation", comps: ["L4.DOMAIN.DISCOVERY", "XC.OBJECTION"], lessons: [
    { type: "micro", competency_id: "L4.DOMAIN.DISCOVERY", title: "Find the real problem", objective: "Teach asking the right questions before proposing an AI solution.", key_points: ["understand the business first", "the stated problem is rarely the real one", "measure before/after"], difficulty: "core" },
    { type: "roleplay", competency_id: "XC.OBJECTION", title: "The sceptical shop owner", objective: "Role-play: a Gujarati saree wholesaler says 'AI is useless, my 30-year shop runs fine.' The learner must handle the objection without over-promising.", key_points: ["stay calm", "address the real concern", "no fabricated promises", "anchor on a risk-free trial"], difficulty: "stretch", pass_mark: 60 },
  ] },
];

async function main() {
  const existing = (await (await fetch(`${BASE}/api/courses`)).json()) as { title: string }[];
  if (existing.some((c) => c.title === "AIE Foundations")) { console.log("AIE Foundations already seeded — skipping."); return; }

  const course = await post("/api/courses", { title: "AIE Foundations", outcome: "Ready to run AI inside a real MSME — the AI Implementation Executive baseline." }) as { course_id: string };
  let order = 1;
  for (const m of MODULES) {
    const mod = await post(`/api/courses/${course.course_id}/modules`, { title: m.title, order: order++, competencies: m.comps }) as { module_id: string };
    let lo = 1;
    for (const l of m.lessons) {
      await post(`/api/modules/${mod.module_id}/lessons`, { ...l, order: lo++, personalize: true });
    }
  }
  await post(`/api/courses/${course.course_id}/publish`, {});
  console.log(`Seeded + published "AIE Foundations": ${MODULES.length} modules, ${MODULES.reduce((n, m) => n + m.lessons.length, 0)} lessons.`);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
