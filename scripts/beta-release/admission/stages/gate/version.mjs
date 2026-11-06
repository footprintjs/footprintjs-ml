export function pythonVersion(version) {
  const m=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/.exec(version);
  return m ? m.slice(1,4).join('.')+'b'+m[4] : null;
}
