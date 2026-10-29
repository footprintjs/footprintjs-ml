export class MLContractError extends Error {
    code;
    constructor(code, message) { super(message); this.name = 'MLContractError'; this.code = code; }
}
export function fail(code, message) { throw new MLContractError(code, message); }
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function nonempty(value, label) {
    if (typeof value !== 'string' || !value.trim())
        fail('invalid-string', `${label} must be a nonempty string`);
    return value;
}
export function finiteNumber(value, label, minimum) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum))
        fail('invalid-number', `${label} must be a finite number${minimum === undefined ? '' : ` >= ${minimum}`}`);
    return value;
}
function positiveInteger(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        fail('invalid-integer', `${label} must be a positive safe integer`);
    return value;
}
/** Reject executable/accessor/class values, cycles, undefined and nonfinite JSON. */
export function cloneJson(value, label = 'value', ancestors = new Set(), depth = 0) {
    if (depth > 64)
        fail('invalid-json', `${label} exceeds the JSON nesting limit`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return finiteNumber(value, label);
    if (typeof value !== 'object')
        fail('invalid-json', `${label} must contain only JSON values`);
    if (ancestors.has(value))
        fail('invalid-json', `${label} contains a cycle`);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
        fail('invalid-json', `${label} must contain plain JSON objects`);
    if (Object.getOwnPropertySymbols(value).length)
        fail('invalid-json', `${label} has symbol properties`);
    const next = new Set(ancestors);
    next.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors))
        if (descriptor.enumerable && !('value' in descriptor))
            fail('invalid-json', `${label}.${key} is an accessor`);
    if (Array.isArray(value)) {
        const result = [];
        for (let index = 0; index < value.length; index++) {
            if (!Object.hasOwn(descriptors, index))
                fail('invalid-json', `${label} contains an array hole`);
            result.push(cloneJson(descriptors[index].value, `${label}[${index}]`, next, depth + 1));
        }
        if (Object.keys(value).some(key => !/^\d+$/.test(key) || Number(key) >= value.length))
            fail('invalid-json', `${label} has non-index array properties`);
        return result;
    }
    const result = {};
    for (const [key, descriptor] of Object.entries(descriptors))
        if (descriptor.enumerable)
            Object.defineProperty(result, key, { value: cloneJson(descriptor.value, `${label}.${key}`, next, depth + 1),
                enumerable: true, configurable: true, writable: true });
    return result;
}
export function jsonObject(value, label = 'value') {
    const copy = cloneJson(value, label);
    if (!isRecord(copy))
        fail('invalid-json', `${label} must be a JSON object`);
    return copy;
}
export function freezeDeep(value) {
    if (value && typeof value === 'object') {
        for (const nested of Object.values(value))
            freezeDeep(nested);
        Object.freeze(value);
    }
    return value;
}
export function detached(value, label = 'value') { return freezeDeep(cloneJson(value, label)); }
export function artifactRef(value) {
    const copy = jsonObject(value, 'artifact');
    if (copy.kind !== 'artifact')
        fail('invalid-artifact', 'Expected kind artifact');
    nonempty(copy.path, 'artifact.path');
    nonempty(copy.format, 'artifact.format');
    if (typeof copy.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(copy.sha256))
        fail('invalid-artifact', 'artifact.sha256 must be a SHA-256 hex digest');
    if (typeof copy.bytes !== 'number' || !Number.isSafeInteger(copy.bytes) || copy.bytes < 0)
        fail('invalid-artifact', 'artifact.bytes must be a nonnegative safe integer');
    return freezeDeep(copy);
}
export function checkpointRef(value) {
    return freezeDeep({ kind: 'checkpoint', artifact: artifactRef(value) });
}
export function readCheckpointRef(value) {
    const copy = jsonObject(value, 'checkpoint');
    if (copy.kind !== 'checkpoint')
        fail('invalid-checkpoint', 'Expected kind checkpoint');
    return checkpointRef(artifactRef(copy.artifact));
}
export function readModelRef(value) {
    const copy = jsonObject(value, 'modelRef');
    if (copy.kind !== 'model')
        fail('invalid-model', 'Expected kind model');
    nonempty(copy.sessionId, 'modelRef.sessionId');
    positiveInteger(copy.handle, 'modelRef.handle');
    artifactRef(copy.originArtifact);
    return freezeDeep(copy);
}
export function readDatasetRef(value) {
    const copy = jsonObject(value, 'datasetRef');
    if (copy.kind !== 'dataset')
        fail('invalid-dataset', 'Expected kind dataset');
    nonempty(copy.sessionId, 'datasetRef.sessionId');
    positiveInteger(copy.handle, 'datasetRef.handle');
    nonempty(copy.role, 'datasetRef.role');
    positiveInteger(copy.rows, 'datasetRef.rows');
    artifactRef(copy.artifact);
    if (!Array.isArray(copy.shape) || !copy.shape.length)
        fail('invalid-dataset', 'datasetRef.shape must be nonempty');
    for (const size of copy.shape)
        positiveInteger(size, 'datasetRef.shape dimension');
    if (copy.shape[0] !== copy.rows)
        fail('invalid-dataset', 'datasetRef.shape[0] must equal rows');
    return freezeDeep(copy);
}
export function sameArtifact(a, b) {
    return a.sha256.toLowerCase() === b.sha256.toLowerCase() && a.bytes === b.bytes && a.format === b.format;
}
export function sameRuntime(a, b) {
    return a.sessionId === b.sessionId && a.handle === b.handle;
}
export function sameDataset(a, b) {
    return sameArtifact(a.artifact, b.artifact) && a.role === b.role && a.rows === b.rows &&
        a.shape.length === b.shape.length && a.shape.every((size, index) => size === b.shape[index]);
}
export function canonicalJson(value) {
    if (Array.isArray(value))
        return '[' + value.map(canonicalJson).join(',') + ']';
    if (isRecord(value))
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' +
            canonicalJson(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
//# sourceMappingURL=contracts.js.map