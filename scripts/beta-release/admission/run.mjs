import {FlowChartExecutor} from 'footprintjs';
import {controlDepRecorder} from 'footprintjs/trace';
import {admissionChart} from './chart.mjs';
export async function runAdmission(facts) {
  const executor=new FlowChartExecutor(admissionChart(facts));
  executor.setReadTracking('full');executor.setWriteTracking('full');
  const decisions=controlDepRecorder({id:'ml-beta-admission'});
  executor.attachCombinedRecorder(decisions);
  await executor.run();
  return {schema:'ml-beta-admission/v1',snapshot:JSON.parse(JSON.stringify(executor.getSnapshot())),
    decisions:JSON.parse(JSON.stringify(decisions.getDecisions()))};
}
