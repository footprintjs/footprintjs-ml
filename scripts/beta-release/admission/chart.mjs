/** Wiring only. Every gate's decision is captured by native decide(). */
import {flowChart} from 'footprintjs';
import {gateIds} from './stages/gate/policy.mjs';
import {ingress} from './stages/facts/index.mjs';
import {evaluate,choose,retain} from './stages/gate/index.mjs';
import {finish} from './stages/result/index.mjs';
export function admissionChart(facts) {
  let chart=flowChart('Read collected release facts',ingress(facts),'facts');
  for(const id of gateIds) {
    chart.addFunction('Evaluate '+id,evaluate(id),'evaluate-'+id);
    const decision=chart.addDeciderFunction('Admit '+id,choose,'decide-'+id);
    decision.addFunctionBranch('pass-'+id,'Retain '+id+' pass',retain(true));
    decision.addFunctionBranch('refuse-'+id,'Retain '+id+' refusal',retain(false));
    chart=decision.end();
  }
  chart.addFunction('Retain admission result',finish,'result');
  return chart.build();
}
