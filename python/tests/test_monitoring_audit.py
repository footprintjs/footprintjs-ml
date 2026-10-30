"""Saved monitoring evidence controls; scalar fixtures only, no numerical runtime."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('monitoring_saved_audit',Path(__file__).resolve().parents[2]/'examples/monitoring/audit.py')
audit=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(audit)


class MonitoringAuditTests(unittest.TestCase):
    def fixture(self):
        window={'windowId':'W','startAt':0,'endAt':10}
        predictions={'window':window,'rows':[{'rowId':'a','eventTime':1,'prediction':1.}, {'rowId':'b','eventTime':2,'prediction':3.}]}
        labels={'window':copy.deepcopy(window),'rows':[{'rowId':'a','eventTime':1,'label':1.}, {'rowId':'b','eventTime':2,'label':4.}]}
        return predictions,labels

    def test_keyed_join_accepts_intact_reordering(self):
        p,l=self.fixture();expected=audit.keyed_join(p,l);l['rows'].reverse()
        self.assertEqual(audit.keyed_join(p,l),expected)
        self.assertEqual(expected[2],.5);self.assertEqual(expected[1]['matchedRows'],2)

    def test_missing_and_partial_labels_retain_actual_coverage(self):
        p,l=self.fixture();rows,facts,mse=audit.keyed_join(p,None)
        self.assertEqual(rows,[]);self.assertIsNone(mse);self.assertEqual(facts['matchedRows'],0)
        l['rows']=l['rows'][:1];rows,facts,mse=audit.keyed_join(p,l)
        self.assertEqual(len(rows),1);self.assertEqual(facts['matchedRows'],1);self.assertEqual(mse,0)

    def test_invalid_joins_never_invent_matching_rows_or_metrics(self):
        for mode in ['duplicate','unmatched','foreign-window','foreign-time']:
            with self.subTest(mode=mode):
                p,l=self.fixture()
                if mode=='duplicate': l['rows'].append(copy.deepcopy(l['rows'][0]))
                elif mode=='unmatched': l['rows'][0]['rowId']='other'
                elif mode=='foreign-window': l['window']['startAt']=1
                else: l['rows'][0]['eventTime']=10
                rows,facts,mse=audit.keyed_join(p,l)
                self.assertEqual(rows,[]);self.assertIsNone(mse)
                self.assertGreater(facts['duplicateRows']+facts['unmatchedRows']+facts['crossWindowRows'],0)

    def test_label_types_and_duplicate_predictions_are_rejected(self):
        for key,value in [('label',True),('label',float('inf')),('eventTime',True),('rowId',False)]:
            p,l=self.fixture();l['rows'][0][key]=value
            with self.assertRaises(ValueError): audit.keyed_join(p,l)
        p,l=self.fixture();p['rows'].append(copy.deepcopy(p['rows'][0]))
        with self.assertRaises(ValueError): audit.keyed_join(p,l)

    def test_half_open_input_bounds_membership_and_numeric_types(self):
        expected={'windowId':'W','startAt':0,'endAt':10,'expectedRows':2}
        doc={'schema':'footprint-ml-monitoring-input/v1','window':{k:expected[k] for k in ('windowId','startAt','endAt')},
            'rows':[{'rowId':'a','eventTime':0,'x':0.},{'rowId':'b','eventTime':9,'x':1.}]}
        self.assertEqual(len(audit.window_rows(doc,expected)),2)
        for mutate in [lambda d:d['rows'][1].update(eventTime=10),lambda d:d['rows'][1].update(rowId='a'),
                       lambda d:d['rows'][0].update(eventTime=True),lambda d:d['rows'][0].update(x=True),lambda d:d.update(rows=[])]:
            bad=copy.deepcopy(doc);mutate(bad)
            with self.assertRaises(ValueError): audit.window_rows(bad,expected)

    def test_evaluation_rejects_wrong_model_context_count_shape_and_metric(self):
        model={'kind':'model','handle':1};context={'preprocessingVersion':'raw','evaluationMethodVersion':'mse','parameters':{}}
        dataset={'rows':2,'shape':[2,1]};table={'rows':[{'prediction':1,'label':1},{'prediction':3,'label':4}]}
        obs={'join':{'joinedDatasetRef':dataset,'matchedRows':2},'evaluation':{**context,'modelRef':model,'datasetRef':dataset,'metrics':{'mse':.5}}}
        audit.validate_evaluation(obs,table,model,context,.5)
        for mutate in [lambda d:d['join']['joinedDatasetRef'].update(shape=[2,True]),lambda d:d['join'].update(matchedRows=True),
                       lambda d:d['evaluation'].update(modelRef={'handle':2}),lambda d:d['evaluation'].update(evaluationMethodVersion='wrong'),
                       lambda d:d['evaluation']['metrics'].update(mse=True),lambda d:d['evaluation']['metrics'].update(mse=9)]:
            bad=copy.deepcopy(obs);mutate(bad)
            with self.assertRaises(ValueError): audit.validate_evaluation(bad,table,model,context,.5)

    def test_managed_artifacts_bind_actual_bytes_and_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);store=root/'release-store';store.mkdir();blob=b'{"v":1}';sha=hashlib.sha256(blob).hexdigest();format='fixture'
            name='sha256-'+sha+'-'+hashlib.sha256(format.encode()).hexdigest()+'.bin'
            ref={'kind':'artifact','path':name,'sha256':sha,'bytes':len(blob),'format':format};(store/name).write_bytes(blob)
            self.assertEqual(audit.managed(root,ref),{'v':1})
            bad=copy.deepcopy(ref);bad['path']='../outside'
            with self.assertRaises(ValueError): audit.managed(root,bad)
            (store/name).write_bytes(b'{"v":2}')
            with self.assertRaises(ValueError): audit.managed(root,ref)

    def test_nonfinite_json_and_boolean_numeric_values_are_rejected(self):
        for blob in ['{"v":NaN}','{"v":Infinity}']:
            with self.assertRaises(ValueError): audit.parse(blob)
        with self.assertRaises(ValueError): audit.number(True)
        with self.assertRaises(ValueError): audit.count(True)


if __name__=='__main__': unittest.main()
