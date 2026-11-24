import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATION_TRACES, runWebTrace } from './helpers/operation-trace-runner.mjs';

test('shared cross-client operation traces satisfy all Web runtime assertions', () => {
  assert.equal(OPERATION_TRACES.schema, 'wuwaterm-operation-traces-v1');
  for (const trace of OPERATION_TRACES.traces) {
    const checkpoints = runWebTrace(trace);
    assert.ok(checkpoints.length > 0, `${trace.id} produced no assertion checkpoints`);
  }
});
