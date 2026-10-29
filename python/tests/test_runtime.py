"""Contract failures that can silently invalidate provenance across a backend boundary."""
from pathlib import Path
import io
import json
import sys
import tempfile
import unittest
import zipfile
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from footprint_ml_adapter.identity import inference_identity, normalize_snapshot, snapshot_sha256
from footprint_ml_adapter.runtime import AdapterRuntime, ContractError, deserialize_snapshot, serialize_snapshot
from footprint_ml_adapter.conformance import run_conformance


PLUGIN = '''
import numpy as np
class Plugin:
    profile = "test-linear-inference/v1"
    def __init__(self, config): self.config=config
    def initialize(self):
        arrays={"x":np.array([[1.],[2.]], dtype="float64"), "y":np.array([[2.],[4.]], dtype="float64")}
        return {"datasets":{r:{"arrays":arrays,"rows":2,"shape":[2,1]} for r in ["train","validation","test"]},
                "metadata":{"preprocessingVersion":"identity/v1","evaluationMethodVersion":"mse/v1"}}
    def train(self, request, source):
        state = source if source is not None else {"w":np.array([1.]),"v":np.array([0.]),"step":0}
        state["v"] += request.get("steps",1)
        state["w"] += request.get("steps",1)
        state["step"] += request.get("steps",1)
        if request.get("resetOptimizer"): state["v"][:] = 0
        return state
    def evaluate(self, state, arrays, parameters):
        if self.config.get("mutateEvaluation"): state["w"][:] += 1
        arrays["x"][:] += 0
        return {"mse":float(np.mean((arrays["x"]*state["w"][0]-arrays["y"])**2))}
    def snapshot(self,state):
        return {"arrays":{"w":state["w"],"v":state["v"]},"metadata":{"step":state["step"]}}
    def restore(self,snapshot):
        return {"w":snapshot["arrays"]["w"].copy(),"v":snapshot["arrays"]["v"].copy(),"step":snapshot["metadata"]["step"]}
    def inference(self,state):
        return {"arrays":{"w":state["w"]},"metadata":{"inferenceCode":"linear/v1","inputSchema":"real1"}}
    def model_metadata(self,state):
        if self.config.get("mutateMetadata"):state["w"][:]+=1
        return {"step":state["step"]}
def create_plugin(config): return Plugin(config)
'''


class IdentityTests(unittest.TestCase):
    def test_canonical_identity_is_order_and_endian_independent_but_binds_shape_dtype_and_spec(self):
        left = {"arrays":{"a":np.array([1.,2.],dtype=">f8"),"z":np.array(3,dtype="int32")},"metadata":{"b":2,"a":1}}
        right = {"metadata":{"a":1,"b":2},"arrays":{"z":np.array(3,dtype="<i4"),"a":np.array([1.,2.],dtype="<f8")}}
        identity = inference_identity(left,"profile/v1")
        self.assertEqual(identity,inference_identity(right,"profile/v1"))
        for changed in [
            {"arrays":{**right["arrays"],"a":right["arrays"]["a"].reshape(1,2)},"metadata":right["metadata"]},
            {"arrays":{**right["arrays"],"a":right["arrays"]["a"].astype("float32")},"metadata":right["metadata"]},
            {"arrays":right["arrays"],"metadata":{"a":1,"b":3}},
        ]:
            self.assertNotEqual(identity,inference_identity(changed,"profile/v1"))
        self.assertNotEqual(identity,inference_identity(right,"other-profile/v1"))
        self.assertNotEqual(identity["sha256"],snapshot_sha256(right,domain="training-state",profile="profile/v1"))

    def test_normalization_copies_and_rejects_nonfinite_or_executable_object_arrays(self):
        array=np.array([1.])
        normalized=normalize_snapshot({"arrays":{"a":array},"metadata":{"a":[1]}})
        array[0]=4
        self.assertEqual(normalized["arrays"]["a"][0],1.)
        for value in [np.array([np.nan]),np.array([np.inf]),np.array([{"payload":1}],dtype=object),np.array(["text"])]:
            with self.assertRaises(ValueError): normalize_snapshot({"arrays":{"bad":value},"metadata":{}})


class SerializationTests(unittest.TestCase):
    def test_npz_roundtrip_maps_arbitrary_names_and_refuses_unmanifested_arrays(self):
        snapshot={"arrays":{"../../weights.npy":np.array([1.,2.]),"scalar":np.array(4,dtype=np.int64)},"metadata":{"step":3}}
        data=serialize_snapshot(snapshot,{"kind":"test","schemaVersion":1})
        restored,envelope=deserialize_snapshot(data)
        self.assertEqual(envelope,{"kind":"test","schemaVersion":1})
        self.assertEqual(restored["metadata"],snapshot["metadata"])
        np.testing.assert_array_equal(restored["arrays"]["../../weights.npy"],snapshot["arrays"]["../../weights.npy"])
        with np.load(io.BytesIO(data),allow_pickle=False) as archive:
            fields={key:archive[key] for key in archive.files}
            self.assertEqual(set(fields),{"metadata","array_00000","array_00001"})
        fields["array_00002"]=np.array([9.])
        output=io.BytesIO();np.savez(output,**fields)
        with self.assertRaises(ValueError): deserialize_snapshot(output.getvalue())

    def test_deserializer_never_unpickles_object_payload(self):
        envelope={"snapshot":{"metadata":{},"arrays":[{"name":"object","key":"array_00000","dtype":"|O","shape":[1]}]}}
        output=io.BytesIO()
        np.savez(output,metadata=np.frombuffer(json.dumps(envelope).encode(),dtype=np.uint8),array_00000=np.array([object()],dtype=object))
        with self.assertRaises(ValueError): deserialize_snapshot(output.getvalue())

    def test_npy_header_cannot_request_an_unbounded_allocation(self):
        envelope={"snapshot":{"metadata":{},"arrays":[{"name":"large","key":"array_00000","dtype":"<f8","shape":[10**12]}]}}
        metadata=io.BytesIO();np.save(metadata,np.frombuffer(json.dumps(envelope).encode(),dtype=np.uint8),allow_pickle=False)
        header=io.BytesIO();np.lib.format.write_array_header_1_0(header,{"descr":"<f8","fortran_order":False,"shape":(10**12,)})
        output=io.BytesIO()
        with zipfile.ZipFile(output,"w") as archive:
            archive.writestr("metadata.npy",metadata.getvalue())
            archive.writestr("array_00000.npy",header.getvalue())
        with self.assertRaisesRegex(ValueError,"header declares"):deserialize_snapshot(output.getvalue())


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.base=Path(self.directory.name)
        self.plugin=self.base/"plugin.py";self.plugin.write_text(PLUGIN)
        self.runtime=AdapterRuntime()
        self.initialized=self.runtime.initialize({"root":str(self.base/"run"),"pluginPath":str(self.plugin),"config":{}})

    def tearDown(self): self.directory.cleanup()

    def test_inplace_continuation_gets_detached_source_and_optimizer_changes_do_not_change_inference(self):
        first=self.runtime.train({"steps":1})
        original=first["modelRef"]
        second=self.runtime.train({"steps":2,"modelRef":original})
        self.assertEqual(self.runtime.inspect({"modelRef":original})["modelRef"],original)
        self.assertNotEqual(original["inferenceIdentity"],second["modelRef"]["inferenceIdentity"])
        reset=self.runtime.train({"steps":0,"resetOptimizer":True,"modelRef":second["modelRef"]})
        self.assertEqual(reset["modelRef"]["inferenceIdentity"],second["modelRef"]["inferenceIdentity"])
        self.assertNotEqual(reset["checkpoint"]["sha256"],second["checkpoint"]["sha256"])

    def test_actual_optimizer_only_mutation_is_refused_even_when_inference_agrees(self):
        trained=self.runtime.train({"steps":1});ref=trained["modelRef"]
        self.runtime._models[ref["handle"]]["state"]["v"][0]+=1
        with self.assertRaises(ContractError) as caught:self.runtime.inspect({"modelRef":ref})
        self.assertEqual(caught.exception.code,"immutable-state-changed")
        self.assertTrue(caught.exception.details["trainingStateChanged"])
        self.assertFalse(caught.exception.details["inferenceChanged"])

    def test_evaluation_mutation_is_detected_after_backend_work(self):
        self.runtime=AdapterRuntime()
        initialized=self.runtime.initialize({"root":str(self.base/"other"),"pluginPath":str(self.plugin),"config":{"mutateEvaluation":True}})
        ref=self.runtime.train({"steps":1})["modelRef"]
        with self.assertRaises(ContractError) as caught:self.runtime.evaluate({"modelRef":ref,"datasetRef":initialized["datasets"]["validation"]})
        self.assertEqual(caught.exception.code,"immutable-state-changed")

    def test_second_initialize_and_metadata_mutation_cannot_republish_a_changed_model(self):
        with self.assertRaises(ContractError) as caught:self.runtime.initialize({"root":str(self.base/"new"),"pluginPath":str(self.plugin)})
        self.assertEqual(caught.exception.code,"already-initialized")
        runtime=AdapterRuntime()
        runtime.initialize({"root":str(self.base/"mutating"),"pluginPath":str(self.plugin),"config":{"mutateMetadata":True}})
        with self.assertRaises(ContractError) as caught:runtime.train({"steps":1})
        self.assertEqual(caught.exception.code,"metadata-mutated-state")
        self.assertEqual(len(runtime._models),0)

    def test_load_reports_actual_bytes_while_resume_requires_intended_bytes(self):
        first=self.runtime.train({"steps":1});second=self.runtime.train({"steps":2})
        wrong={**first["checkpoint"],"path":second["checkpoint"]["path"]}
        loaded=self.runtime.load({"checkpoint":{"kind":"checkpoint","artifact":wrong}})
        self.assertEqual(loaded["actualArtifact"],second["checkpoint"])
        with self.assertRaises(ContractError) as caught:self.runtime.train({"steps":1,"fromCheckpoint":wrong})
        self.assertEqual(caught.exception.code,"checkpoint-mismatch")
        ref=loaded["modelRef"];self.runtime.dispose({"modelRef":ref})
        with self.assertRaises(ContractError):self.runtime.inspect({"modelRef":ref})

    def test_optional_conformance_case_is_partial_and_dataset_role_is_configurable(self):
        report=run_conformance(str(self.plugin),{}, {"train":{"steps":1},"continue":{"steps":1},
            "evaluationDatasetRole":"test","metric":"mse","operator":"lte","threshold":100.},self.base/"conformance")
        self.assertEqual(report["status"],"partial")
        self.assertFalse(report["passed"])
        self.assertTrue(report["requiredPassed"])
        self.assertEqual(report["counts"]["skipped"],1)
        self.assertEqual(report["counts"]["failed"],0)
        self.assertEqual(report["coverage"]["evaluationDatasetRole"],"test")
        case=next(case for case in report["cases"] if case["status"]=="skipped")
        self.assertIsNone(case["passed"])


if __name__=="__main__": unittest.main()
