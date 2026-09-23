// 家属代传授权：必须验证关系与范围，且在有效期内、未被撤销。

export function validateProxyGrant(grant) {
  const errors = [];
  if (!grant || typeof grant !== "object") return ["授权为空或格式不正确"];
  if (!grant.proxy_id?.trim?.()) errors.push("缺少代传家属标识 proxy_id");
  if (!grant.patient_id?.trim?.()) errors.push("缺少患者标识 patient_id");
  if (!grant.relationship?.trim?.()) errors.push("缺少与患者的关系 relationship");
  if (!grant.verified_by?.trim?.()) errors.push("缺少核验人 verified_by");
  if (!grant.verification_method?.trim?.()) errors.push("缺少核验方式 verification_method");
  if (!Array.isArray(grant.scope?.sections) || grant.scope.sections.length === 0) {
    errors.push("缺少授权范围 scope.sections");
  }
  if (!grant.valid_from) errors.push("缺少生效时间 valid_from");
  if (!grant.valid_until) errors.push("缺少失效时间 valid_until");
  return errors;
}

// section 取值：submission / material / answer。at 为 ISO 时间串。
export function grantCovers(grant, { section, at }) {
  if (!grant || grant.revoked) return false;
  if (!grant.scope.sections.includes(section)) return false;
  return grant.valid_from <= at && at <= grant.valid_until;
}
