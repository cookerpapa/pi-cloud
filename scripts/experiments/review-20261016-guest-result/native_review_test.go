// Baseline characterization: run against the exact patched native package.
package execution

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/pkg/cio"
	"github.com/opencontainers/runtime-spec/specs-go"
)

func TestReviewActualGuestProgress(t *testing.T) {
	for _, name := range []string{"small", "truncated"} {
		frame, err := os.ReadFile(filepath.Join(os.Getenv("REVIEW_FIXTURES"), name+"-progress.json"))
		if err != nil {
			t.Fatal(err)
		}
		forwarded := 0
		output := newToolOutput(8*1024*1024, func(json.RawMessage) { forwarded++ })
		if _, err := output.Write(append(frame, '\n')); err != nil {
			t.Fatal(err)
		}
		want := 1
		if name == "truncated" {
			want = 0
		}
		if forwarded != want {
			t.Fatalf("%s: forwarded %d, want %d", name, forwarded, want)
		}
		t.Logf("case=%s frame_bytes=%d forwarded=%d", name, len(frame), forwarded)
	}
}

type reviewProcess struct {
	containerd.Process
	t      *testing.T
	io     cio.IO
	frames []byte
	code   uint32
	exits  chan containerd.ExitStatus
}

func (p *reviewProcess) Start(context.Context) error {
	go func() {
		defer func() {
			p.exits <- *containerd.NewExitStatus(p.code, time.Now(), nil)
			close(p.exits)
		}()
		config := p.io.Config()
		out, err := os.OpenFile(config.Stdout, os.O_WRONLY, 0)
		if err != nil {
			p.t.Error(err)
			return
		}
		defer out.Close()
		in, err := os.OpenFile(config.Stdin, os.O_RDONLY, 0)
		if err != nil {
			p.t.Error(err)
			return
		}
		defer in.Close()
		// The same actual containerd FIFO adapter feeds the maintained parser.
		if _, err := out.Write(p.frames); err != nil {
			p.t.Error(err)
			return
		}
		reader := bufio.NewReader(in)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				p.t.Error(err)
				return
			}
			if line == "{\"type\":\"scope.received\"}\n" {
				return
			}
		}
	}()
	return nil
}
func (p *reviewProcess) Wait(context.Context) (<-chan containerd.ExitStatus, error) {
	return p.exits, nil
}
func (p *reviewProcess) Kill(context.Context, syscall.Signal, ...containerd.KillOpts) error {
	return nil
}
func (p *reviewProcess) IO() cio.IO { return p.io }
func (p *reviewProcess) Delete(context.Context, ...containerd.ProcessDeleteOpts) (*containerd.ExitStatus, error) {
	return containerd.NewExitStatus(p.code, time.Now(), nil), nil
}

type reviewTask struct {
	containerd.Task
	t        *testing.T
	frames   []byte
	code     uint32
	cleanups int
}

func (t *reviewTask) Spec(context.Context) (*specs.Spec, error) {
	return &specs.Spec{Process: &specs.Process{}}, nil
}
func (t *reviewTask) Exec(_ context.Context, id string, _ *specs.Process, creator cio.Creator) (containerd.Process, error) {
	output, err := creator(id)
	if err != nil {
		return nil, err
	}
	frames, code := t.frames, t.code
	if strings.HasPrefix(id, "ps-") {
		t.cleanups++
		frames = []byte("{\"type\":\"scope.ready\"}\n{\"type\":\"scope.stop_result\",\"empty\":true}\n")
		code = 0
	}
	return &reviewProcess{t: t.t, io: output, frames: frames, code: code, exits: make(chan containerd.ExitStatus, 1)}, nil
}

func TestReviewReceiptFailureDiscardsCompletedResult(t *testing.T) {
	for _, ack := range []bool{true, false} {
		t.Run(fmt.Sprint(ack), func(t *testing.T) {
			frames, err := os.ReadFile(filepath.Join(os.Getenv("REVIEW_FIXTURES"), "scope-"+fmt.Sprint(ack)+".jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(frames), `"isError":false`) {
				t.Fatal("successful result missing from guest fixture")
			}
			payload, err := os.ReadFile(filepath.Join(os.Getenv("REVIEW_FIXTURES"), "payload-"+fmt.Sprint(ack)+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var identity struct {
				Request struct {
					OperationID string `json:"operationId"`
				} `json:"request"`
			}
			if err := json.Unmarshal(payload, &identity); err != nil {
				t.Fatal(err)
			}
			r := request()
			r.OperationID, r.Payload, r.MaximumOutputBytes = identity.Request.OperationID, payload, 8*1024*1024
			task := &reviewTask{t: t, frames: frames}
			if !ack {
				task.code = 1
			}
			driver := &ContainerdDriver{
				FIFODirectory: t.TempDir(),
				Resolve: func(context.Context, Request) (ResolvedTask, error) {
					return ResolvedTask{Task: task, Namespace: "review"}, nil
				},
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			result := driver.Run(ctx, r, func(json.RawMessage) {})
			if ack && (len(result.Output) == 0 || result.Failure != "" || task.cleanups != 0) {
				t.Fatalf("healthy receipt changed outcome: %+v cleanups=%d", result, task.cleanups)
			}
			if !ack && (len(result.Output) != 0 || result.Failure == "" || task.cleanups != 1) {
				t.Fatalf("receipt defect was not reproduced: %+v cleanups=%d", result, task.cleanups)
			}
			t.Logf("acknowledged=%t output_retained=%t failure=%s scope_cleanup_calls=%d quarantine=%t",
				ack, len(result.Output) != 0, result.Failure, task.cleanups, result.Quarantine)
		})
	}
}
