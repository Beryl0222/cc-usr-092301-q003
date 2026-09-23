const required = ["event_id", "kind", "occurred_at", "subject_id", "version"];
const roles = new Set(["patient", "proxy", "clinician", "system"]);

export function validate(record) {
  const problems = required.filter((name) => !(name in record));
  if ("actor" in record && !roles.has(record.actor?.role)) problems.push("actor.role");
  return problems;
}
