export function finish(scope) {
  const results=JSON.parse(JSON.stringify(scope.results));
  scope.outcome={allowed:results.every(r=>r.allowed===true),refused:results.filter(r=>!r.allowed).map(r=>r.gate),
    procedure:'Claude dispatches after exact-head review and owner go for this version; workflow does not enforce that procedure.',
    mode:scope.facts.attempt===1 && scope.facts.tagStatus===404 && scope.facts.releaseStatus===404?'first-attempt':'verify-only',sourceCI:scope.facts.ci};
}
