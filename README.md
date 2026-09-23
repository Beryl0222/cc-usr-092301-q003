# 问诊前AI意见交接

本仓库保存业务参与方已经确认的事件信封、逐类载荷规则、示例与最小校验代码，供后续服务沿用共同标识和时间语义。

## 背景

患者带着 AI 工具给出的结论就诊已成常态。平台只负责**交接**：把患者的问题、症状时间线、既往史、测量值、图片/报告、所用 AI 工具及答案原文（含生成时间、版本、缺失上下文标注）按一次就医目的整理好交给医生。平台**不确诊、不出处置方案**；最终检查与治疗决定由医生单独签署并保留解释。

## 事件模型

所有事件共用信封：`event_id`、`kind`、`occurred_at`（ISO 8601 带时区）、`subject_id`（患者主体）、`version`（信封版本）、`payload`。事件只追加不改写，历史决策始终可复核。

| kind | 语义与关键规则 |
| --- | --- |
| `SUBMISSION_CREATED` | 按一次就医目的提交问题、症状时间线、既往史、测量值；家属代传必须引用已核验授权 |
| `MATERIAL_RECEIVED` | 图片/报告/化验单/截屏入库；`content_hash` 识别重复上传，重复件以 `duplicate_of` 指向首次入库材料 |
| `AI_ANSWER_RECORDED` | 记录 AI 答案出处：工具名与版本、生成时间、原文摘要、缺失上下文、依据材料；**禁止确诊断言与诊断编码**；引用旧答案须带其生成时间以暴露新旧 |
| `RISK_FLAG_RAISED` | 胸痛、呼吸急促、意识变化等危险信号：`instruction` 固定为 `seek_emergency_care_offline`，载荷不得夹带诊断或处置方案 |
| `SHARING_CONSENT_GRANTED` | 患者授权把指定范围资料共享给某机构/医生 |
| `MATERIAL_WITHDRAWN` | 撤回材料：未用于诊疗则 `stop_sharing` 停止共享；已成为已签署决定依据则 `retain_as_medical_record` 按病历规则留痕，须注明依据与责任主体 |
| `PROXY_AUTHORIZATION_VERIFIED` | 家属代传前核验亲属/监护关系、授权范围与有效期 |
| `ADVICE_REVIEW_RECORDED` | 医生对某条机器建议 `cite` / `challenge` / `reject`，必须保留解释 |
| `CLINICAL_PLAN_SIGNED` | 最终检查与治疗决定：责任医生单独签署（`signature_ref`），每项条目保留解释，可登记所依据的材料与 AI 答案 |
| `APPOINTMENT_RESCHEDULED` | 预约改期只改时间不动资料，接诊者始终看到同一份最新资料 |
| `REFERRAL_CREATED` | 跨机构转诊须引用患者授权、限定携带范围，目标机构不得与原机构相同 |

## 校验

- `validate(record)`：单条事件的信封与载荷校验，返回错误信息数组（空数组为通过）。
- `validateStream(events)`：在单条校验之上追加跨事件不变量——引用完整性（答案→材料、审阅→答案、签署→依据）、重复上传指向、撤回处置与病历留痕前提、代传授权时序与范围、转诊授权。

机器提示与已确认内容的区分由事件类型本身保证：患者侧看到的 `AI_ANSWER_RECORDED` 永远只是机器提示，只有 `ADVICE_REVIEW_RECORDED`（医生表态）与 `CLINICAL_PLAN_SIGNED`（医生签署）才代表有责任主体确认。

## 本地检查

```sh
npm test
```

测试覆盖：`fixtures/events/` 下每类事件的合法样例、完整事件流，以及关键违规场景（AI 答案缺出处标注、危险信号夹带诊断、已入病历材料被停止共享、代传授权缺失/过期/超范围、重复上传指向错误、转诊无授权等）。
