"""Transport fixture only. Numerical results and inspections are fabricated."""
import json
import os
import sys
import time

mode = os.environ.get('KIT_FIXTURE_MODE', 'healthy')
session = 'fixture-python-session'
profile = 'fixture/arbitrary-v1'
artifact = {'kind': 'artifact', 'path': 'fixture.bin', 'sha256': 'a' * 64, 'bytes': 4, 'format': 'fixture/v1'}
model = {'kind': 'model', 'sessionId': session, 'handle': 10, 'originArtifact': artifact,
         'inferenceIdentity': {'kind': 'inference-identity', 'schemaVersion': 1, 'profile': profile, 'sha256': 'c' * 64}}
dataset = {'kind': 'dataset', 'sessionId': session, 'handle': 1, 'artifact': artifact, 'role': 'calibration', 'rows': 3, 'shape': [3, 2]}
for line in sys.stdin:
    request = json.loads(line)
    command, args = request['command'], request['args']
    if command == 'initialize':
        value = {'backend': {'sessionId': session, 'profile': 'wrong/profile' if mode == 'wrong-profile' else profile,
                            'pluginSourceSha256': 'b' * 64, 'preprocessingVersion': 'fixture/preprocessing',
                            'evaluationMethodVersion': 'fixture/method'}, 'datasets': {'calibration': dataset}}
    elif command == 'shutdown':
        print(json.dumps({'id': request['id'], 'ok': True, 'result': {}}), flush=True)
        break
    else:
        if mode == 'timeout':
            time.sleep(60)
        if mode == 'malformed':
            print('not-json', flush=True)
            continue
        if mode == 'unknown-id':
            print(json.dumps({'id': request['id'] + 100, 'ok': True, 'result': {}}), flush=True)
            continue
        observed = dict(model)
        if mode == 'missing-identity':
            observed.pop('inferenceIdentity')
        if mode == 'foreign-session':
            observed['sessionId'] = 'other-session'
        if command == 'train':
            value = {'modelRef': observed, 'checkpoint': artifact}
        elif command == 'load':
            observed['originArtifact'] = args['checkpoint']['artifact']
            model = observed
            value = {'modelRef': observed, 'actualArtifact': observed['originArtifact']}
        elif command == 'evaluate':
            value = {'modelRef': observed, 'datasetRef': dataset, 'evaluationId': 'fixture-evaluation',
                     'preprocessingVersion': 'fixture/preprocessing', 'evaluationMethodVersion': 'fixture/method',
                     'parameters': args.get('parameters', {}), 'metrics': {'mse': 0.125}}
        else:
            value = {'modelRef': observed}
            if command == 'dispose':
                value['released'] = True
    print(json.dumps({'id': request['id'], 'ok': True, 'result': value}), flush=True)
