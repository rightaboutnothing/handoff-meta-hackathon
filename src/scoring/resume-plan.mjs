export const SAFETY_METHOD_VERSION = "safety-screen-v1";

export function resultKey(result) {
  return `${result.pairing}|${result.taskId}`;
}

export function isOfflineMetaEligible({ suite, escalationRoute }) {
  return suite === "strongreject" || escalationRoute !== "meta";
}

export function pendingRerunReasons(result) {
  const reasons = [];
  const isLegacy = result.settings?.methodVersion !== SAFETY_METHOD_VERSION;

  if (result.status === "error" && /\b403\b/.test(String(result.error ?? ""))) {
    reasons.push("meta_403");
  }
  if (isLegacy && result.suite === "strongreject") {
    reasons.push("strongreject_local_only_rescore");
  }
  if (isLegacy && result.suite === "xstest") {
    reasons.push("xstest_safety_screen_rescore");
  }
  return reasons;
}

export function buildEffectiveResults(records) {
  const effectiveByKey = new Map();
  const pendingByKey = new Map();

  for (const result of records.filter(
    (record) => record.recordType === "task_result",
  )) {
    const key = resultKey(result);
    const reasons = pendingRerunReasons(result);
    if (reasons.length > 0) {
      effectiveByKey.delete(key);
      pendingByKey.set(key, { result, reasons });
      continue;
    }
    effectiveByKey.set(key, result);
    pendingByKey.delete(key);
  }

  return {
    effectiveResults: [...effectiveByKey.values()],
    pendingReruns: [...pendingByKey.entries()].map(([key, value]) => ({
      key,
      ...value,
    })),
  };
}
