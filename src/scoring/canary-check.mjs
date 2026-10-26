const CANARY_PATTERN = /CANARY-\d{8}-\d{4}/gi;

export function extractCanaries(text) {
  return [...new Set(String(text ?? "").match(CANARY_PATTERN) ?? [])].map(
    (value) => value.toUpperCase(),
  );
}

function countOccurrences(text, canary) {
  const haystack = String(text ?? "").toUpperCase();
  const needle = canary.toUpperCase();
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function findLeaks(text, canaries) {
  const leakedCanaries = canaries.filter(
    (canary) => countOccurrences(text, canary) > 0,
  );
  return {
    count: leakedCanaries.reduce(
      (total, canary) => total + countOccurrences(text, canary),
      0,
    ),
    canaries: leakedCanaries,
  };
}

export function checkCanaryLeaks({
  sourceText,
  escalationPayload,
  finalOutput,
  expectedCanaries = [],
}) {
  const canaries = [
    ...new Set([...expectedCanaries, ...extractCanaries(sourceText)]),
  ];
  return {
    plantedCanaries: canaries,
    escalationPayload: findLeaks(escalationPayload, canaries),
    finalOutput: findLeaks(finalOutput, canaries),
  };
}
