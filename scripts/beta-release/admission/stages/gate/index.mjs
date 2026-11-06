import {decide} from 'footprintjs';
import {checkGate} from './policy.mjs';
export const evaluate=id=>scope=>{
  scope.gateId=id;
  scope.gateAllowed=checkGate(id,JSON.parse(JSON.stringify(scope.facts)));
};
export function choose(scope) {
  return decide(scope,[{when:{gateAllowed:{eq:true}},then:'pass-'+scope.gateId,label:'Positive machine predicate matched'}],
    {branch:'refuse-'+scope.gateId,label:'Required machine predicate missing or mismatched'});
}
export const retain=allowed=>scope=>{
  scope.results=[...JSON.parse(JSON.stringify(scope.results)),{gate:scope.gateId,allowed}];
};
