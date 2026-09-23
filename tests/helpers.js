import { createService } from "../src/service.js";

// 固定时钟，保证事件时间可预期、可断言。
export function setup() {
  let tick = 0;
  const service = createService({
    now: () => `2026-09-23T09:${String(++tick).padStart(2, "0")}:00+08:00`,
  });
  const patient = { id: "p-1", role: "patient" };
  const doctor = { id: "d-1", role: "clinician" };
  const draft = {
    patient_id: "p-1",
    visit_purpose: "头痛复诊",
    questions: [{ text: "AI说可能是偏头痛，需要做什么检查？" }],
    symptom_timeline: [{ symptom: "间歇性头痛", started_at: "2026-09-10", course: "逐渐加重" }],
    medical_history: [{ condition: "高血压", since: "2020" }],
    measurements: [{ name: "血压", value: "138/86", unit: "mmHg", measured_at: "2026-09-22T08:00:00+08:00" }],
  };
  return { service, patient, doctor, draft };
}

export const sampleAnswer = {
  tool: { name: "某健康助手", version: "3.2.1" },
  generated_at: "2026-09-22T21:30:00+08:00",
  answer_text: "根据描述可能是紧张性头痛，建议观察。",
  input_summary: "症状描述与血压值",
  missing_context: ["未提供既往影像资料"],
};
