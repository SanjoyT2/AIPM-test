/**
 * Loads the editable frameworks (d2d/config/*.yaml), validates them against their
 * JSON Schemas and invariants (weight sums), and exposes them as one typed bundle.
 *
 * Fail-loud policy: the service refuses to boot on an invalid framework — a bad
 * edit must never silently score a learner (ADR-006).
 *
 * Also runnable standalone:  npm run validate:config
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { settings } from "./settings.js";
import { compileSchema } from "./validation.js";

export interface FrameworkBundle {
  competencyFramework: any;
  compositeFormula: any;
  progressionRules: any;
  diagnostic: any;
  guardrails: any;
  critics: any;
  costModel: any;
  rubrics: { gates: any; taskGrading: any };
  versions: Record<string, string>;
}

function loadYaml(rel: string): any {
  const file = path.join(settings.configDir, rel);
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

function loadSchema(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(settings.schemaDir, name), "utf8"));
}

function assertSums(label: string, weights: number[], errors: string[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1.0) > 1e-6) errors.push(`${label}: weights sum to ${sum.toFixed(4)}, expected 1.0`);
}

export function loadFrameworks(): FrameworkBundle {
  const errors: string[] = [];

  const competencyFramework = loadYaml("competency-framework.yaml");
  const compositeFormula = loadYaml("composite-formula.yaml");
  const progressionRules = loadYaml("progression-rules.yaml");
  const diagnostic = loadYaml("diagnostic.yaml");
  const guardrails = loadYaml("guardrails.yaml");
  const critics = loadYaml("critics.yaml");
  const costModel = loadYaml("cost-model.yaml");
  const gates = loadYaml(path.join("rubrics", "gates.yaml"));
  const taskGrading = loadYaml(path.join("rubrics", "task-grading.yaml"));

  // --- Schema validation (competency framework has a dedicated schema) ---
  const validate = compileSchema(loadSchema("competency-framework.schema.json"));
  if (!validate(competencyFramework)) {
    for (const e of validate.errors ?? []) errors.push(`competency-framework: ${e.instancePath} ${e.message}`);
  }

  // --- Invariants the pure JSON Schema can't express: weight sums ---
  assertSums(
    "composite-formula.source_weights",
    Object.values(compositeFormula.source_weights as Record<string, number>),
    errors,
  );
  for (const level of competencyFramework.levels ?? []) {
    assertSums(
      `competency-framework level ${level.id}`,
      (level.competencies ?? []).map((c: any) => c.weight_in_level ?? 0),
      errors,
    );
  }
  for (const [name, rubric] of Object.entries<any>(gates.rubrics ?? {})) {
    assertSums(`gates rubric ${name}`, (rubric.criteria ?? []).map((c: any) => c.weight ?? 0), errors);
  }
  assertSums("task-grading rubric", (taskGrading.criteria ?? []).map((c: any) => c.weight ?? 0), errors);

  // --- Guardrail policies must reference defined rules ---
  const ruleIds = new Set(Object.keys(guardrails.rules ?? {}));
  for (const [policy, rules] of Object.entries<string[]>(guardrails.policies ?? {})) {
    for (const r of rules) if (!ruleIds.has(r)) errors.push(`guardrails policy '${policy}' references unknown rule '${r}'`);
  }

  if (errors.length) {
    throw new Error(`Framework validation failed:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    competencyFramework,
    compositeFormula,
    progressionRules,
    diagnostic,
    guardrails,
    critics,
    costModel,
    rubrics: { gates, taskGrading },
    versions: {
      competency_framework: competencyFramework.version,
      composite_formula: compositeFormula.version,
      progression_rules: progressionRules.version,
      guardrails: guardrails.version,
      critics: critics.version,
      cost_model: costModel.version,
      gates_rubrics: gates.version,
      task_grading_rubric: taskGrading.version,
    },
  };
}

// Standalone: `npm run validate:config`
if (process.argv[1] && path.resolve(process.argv[1]).includes("config-loader")) {
  try {
    const bundle = loadFrameworks();
    console.log("All frameworks valid. Versions:");
    for (const [k, v] of Object.entries(bundle.versions)) console.log(`  ${k}: ${v}`);
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
}
