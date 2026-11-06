/** JSON data shape only. Unknown fields never become a positive predicate. */
export const text=value=>typeof value==='string'&&value.length>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
function fields(row,strings,integers=[]) {
 if(!object(row)||!strings.every(k=>Object.hasOwn(row,k)&&text(row[k]))||
   !integers.every(k=>Object.hasOwn(row,k)&&positive(row[k])))throw Error('native-field-profile');
}
function conclusion(row) {
 // Native nonterminal runs/steps have explicit null conclusions. They cannot clear checks.
 if(!Object.hasOwn(row,'conclusion')||
   !(text(row.conclusion)||(row.status!=='completed'&&row.conclusion===null)))throw Error('native-conclusion-profile');
}
export function historyRun(row) {
 fields(row,['display_title','head_sha','event','path','status'],['id','run_number','workflow_id']);
 if(!/^[a-f0-9]{40}$/.test(row.head_sha))throw Error('native-source-profile');
}
export function ciRun(row) {
 fields(row,['head_sha','head_branch','event','path','status'],['id','run_attempt']);
 if(!/^[a-f0-9]{40}$/.test(row.head_sha))throw Error('native-source-profile');
 conclusion(row);
}
export function jobRows(rows,run) {
 for(const row of rows) {
  fields(row,['name','status'],['id','run_id']);conclusion(row);
  if(row.run_id!==run||!Array.isArray(row.steps))throw Error('native-job-profile');
  for(const step of row.steps) {fields(step,['name','status']);conclusion(step);}
 }
}
