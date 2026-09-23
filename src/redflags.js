// 危险信号筛查。硬性边界：平台只输出"立即线下处置"的引导，绝不输出诊断结论。
export const TRIAGE_NOTICE = "本提示仅为安全引导，不构成医疗诊断，平台不作确诊。";

// 需求点名的三类（胸痛、呼吸急促、意识变化）在前；规则表可继续扩充。
const RULES = [
  { id: "CHEST_PAIN", label: "胸痛", pattern: /胸痛|胸闷|胸口痛|心前区痛|胸部压榨感|心绞痛/ },
  { id: "DYSPNEA", label: "呼吸急促", pattern: /呼吸急促|呼吸困难|喘不上气|气促|气短|窒息感/ },
  { id: "CONSCIOUSNESS_CHANGE", label: "意识变化", pattern: /意识模糊|意识不清|神志不清|昏迷|昏厥|晕厥|叫不醒|嗜睡难醒/ },
  { id: "SEVERE_BLEEDING", label: "严重出血", pattern: /大出血|血流不止|呕血|咯血/ },
  { id: "STROKE_SIGN", label: "中风征象", pattern: /口角歪斜|言语不清|突然失语|半身不遂|一侧肢体无力/ },
];

// 只扫描本次就诊的当前主诉：问题、症状时间线、测量值。
// 既往史是背景资料，既往记录不应当作当前危险信号。
function currentTexts(draft) {
  const texts = [];
  for (const q of draft.questions ?? []) texts.push({ where: "questions", text: q.text ?? "" });
  for (const s of draft.symptom_timeline ?? []) {
    texts.push({ where: "symptom_timeline", text: `${s.symptom ?? ""} ${s.course ?? ""}` });
  }
  for (const m of draft.measurements ?? []) {
    texts.push({ where: "measurements", text: `${m.name ?? ""} ${m.value ?? ""}` });
  }
  return texts;
}

export function screenSubmission(draft) {
  const matched = [];
  for (const rule of RULES) {
    for (const { where, text } of currentTexts(draft)) {
      const hit = text.match(rule.pattern);
      if (hit) {
        matched.push({ rule_id: rule.id, label: rule.label, where, evidence: hit[0] });
        break; // 同一规则记录一次即可
      }
    }
  }
  if (matched.length === 0) return { level: "ROUTINE", matched: [], directive: null };
  return {
    level: "EMERGENCY",
    matched,
    directive: {
      action: "SEEK_EMERGENCY_CARE",
      instructions: [
        "立即停止线上填写，拨打急救电话 120 或前往最近的急诊部门",
        "等待救援期间保持镇静，不要自行驾车，不要进食饮水",
        "如有可能，请家属陪同并携带本提交中的测量值与报告",
      ],
      notice: TRIAGE_NOTICE,
    },
  };
}
