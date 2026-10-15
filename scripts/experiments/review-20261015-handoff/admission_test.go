// Audit-only probes, compiled with the pinned maintained Cube admission source.
package execution

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
)

func TestReviewTwoDistinctOperationsAtOneKafkaPosition(t *testing.T) {
	started := make(chan struct{})
	m := New(driverFunc(func(ctx context.Context, _ Request, _ func(json.RawMessage)) Result {
		close(started)
		<-ctx.Done()
		return Result{}
	}), deliveryFunc(func(context.Context, Request, Result) error { return nil }))
	defer m.Close()
	first := request()
	first.SandboxID = "aabbccddeeff00112233445566778899"
	first.Source.Topic = "pi-cloud.execution-log.v17"
	if why := m.Submit(m.BootID, first); why != "" {
		t.Fatal(why)
	}
	await(t, started)
	second := first
	second.OperationID = uuid.NewString()
	second.Payload = json.RawMessage(`{"tool":"read","path":"another.txt"}`)
	why := m.Submit(m.BootID, second)
	if why != "execution_position_stale" {
		t.Fatalf("observed behavior changed: %s", why)
	}
	fmt.Println(`REVIEW_EVIDENCE {"case":"same_position","firstAccepted":true,"distinctSecondOperation":"execution_position_stale"}`)
}

func TestReviewLateSubmitRecreatesForgottenRuntimePosition(t *testing.T) {
	present := true
	executions := 0
	m := New(driverFunc(func(context.Context, Request, func(json.RawMessage)) Result {
		if !present {
			return Result{Failure: "tool_sandbox_unavailable"}
		}
		executions++
		return Result{}
	}), deliveryFunc(func(context.Context, Request, Result) error { return nil }))
	defer m.Close()
	r := request()
	r.SandboxID = "aabbccddeeff00112233445566778899"
	r.Source.Topic = "pi-cloud.execution-log.v17"
	if why := m.Submit(m.BootID, r); why != "" {
		t.Fatal(why)
	}
	m.wg.Wait()
	m.ForgetRuntime(r.SandboxID)
	present = false
	m.mu.Lock()
	before := len(m.positions)
	m.mu.Unlock()
	r.OperationID = uuid.NewString()
	r.Source.Offset = "101"
	why := m.Submit(m.BootID, r)
	m.wg.Wait()
	m.mu.Lock()
	after := len(m.positions)
	active := len(m.operations)
	m.mu.Unlock()
	if why != "" || before != 0 || after != 1 || active != 0 || executions != 1 {
		t.Fatalf("unexpected behavior: %q %d %d %d %d", why, before, after, active, executions)
	}
	fmt.Println(`REVIEW_EVIDENCE {"case":"late_deleted_vm","accepted":true,"positionsAfterForget":0,"positionsAfterLateReply":1,"activeOperations":0,"newEffects":0}`)
}
