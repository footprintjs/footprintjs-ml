"""Saved-audit acceptance controls; synthetic scalar tables, no trainer/NumPy."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('regression_saved_audit', Path(__file__).resolve().parents[2] / 'examples/regression/audit.py')
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class RegressionAuditTests(unittest.TestCase):
    def fixture(self):
        model = {'kind': 'model', 'handle': 1}
        dataset = {'rows': 2, 'shape': [2, 1], 'artifact': {'sha256': 'a' * 64}}
        document = {'schema': 'footprint-ml-regression-data/v1', 'rows': [
            {'rowId': 'x', 'population': 'majority', 'x': 0., 'y': 1.},
            {'rowId': 'y', 'population': 'rare', 'x': 1., 'y': 4.}]}
        comparison = {'preprocessingVersion': 'raw/v1', 'evaluationMethodVersion': 'mse/v1', 'parameters': {}}
        receipt = {**comparison, 'modelRef': model, 'datasetRef': dataset, 'metrics': {'mse': .5}}
        observed = {'modelRef': model, 'datasetRef': dataset, 'rowIds': ['x', 'y'], 'predictions': [1., 3.], 'mse': .5}
        predictor = {'schema': 'footprint-ml-regression-predictor/v1', 'profile': audit.PROFILE, 'weights': {'slope': 2., 'intercept': 1.}}
        return copy.deepcopy([observed, model, dataset, receipt, predictor, document, comparison])

    def test_complete_scalar_prediction_table_matches(self):
        self.assertEqual(audit.validate_table(*self.fixture()), .5)

    def test_predictions_cannot_be_empty_truncated_or_extended(self):
        for predictions in ([], [1.], [1., 3., 3.]):
            with self.subTest(predictions=predictions):
                data = self.fixture(); data[0]['predictions'] = predictions
                with self.assertRaises(ValueError): audit.validate_table(*data)

    def test_nonfinite_and_boolean_predictions_are_rejected(self):
        for value in (True, float('nan'), float('inf'), '1'):
            with self.subTest(value=value):
                data = self.fixture(); data[0]['predictions'][0] = value
                with self.assertRaises(ValueError): audit.validate_table(*data)

    def test_boolean_counts_and_shape_dimensions_are_not_integer_evidence(self):
        for field, value in [('rows', True), ('shape', [2, True]), ('shape', [2., 1])]:
            with self.subTest(field=field,value=value):
                data = self.fixture(); data[2][field] = value
                with self.assertRaises(ValueError): audit.validate_table(*data)

    def test_wrong_model_dataset_membership_and_protocol_are_rejected(self):
        for mutate in [lambda d: d[0].update(modelRef={'kind':'model','handle':2}),
                       lambda d: d[0].update(datasetRef={'rows':3}),
                       lambda d: d[0].update(rowIds=['y','x']),
                       lambda d: d[3].update(evaluationMethodVersion='different'),
                       lambda d: d[3].update(parameters={'changed':True})]:
            data = self.fixture(); mutate(data)
            with self.assertRaises(ValueError): audit.validate_table(*data)

    def test_changed_metrics_and_predictor_arithmetic_are_rejected(self):
        for mutate in [lambda d: d[0].update(mse=.1), lambda d: d[3]['metrics'].update(mse=.1),
                       lambda d: d[4]['weights'].update(slope=1), lambda d: d[4]['weights'].update(intercept=True),
                       lambda d: d[5]['rows'][0].update(y=float('nan'))]:
            data = self.fixture(); mutate(data)
            with self.assertRaises(ValueError): audit.validate_table(*data)

    def test_duplicate_row_identity_and_nonfinite_json_are_rejected(self):
        data = self.fixture()[5]; data['rows'][1]['rowId'] = 'x'
        with self.assertRaises(ValueError): audit.rows(data)
        for content in ('{"x":NaN}', '{"x":Infinity}'):
            with self.assertRaises(ValueError): audit.parse(content)


if __name__ == '__main__':
    unittest.main()
